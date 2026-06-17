/**
 * Morning Coffee Lib — Helper functions for the morning email digest pipeline
 *
 * Provides:
 * - Composio SDK integration for Gmail (@composio/core v0.10, camelCase API)
 * - Email fetching and parsing
 * - Markdown output formatting
 *
 * Errors are propagated (not swallowed) so the pipeline can show the real
 * cause instead of pretending the inbox is empty.
 */

import { createRequire } from "module";
import { hostname } from "os";

const require = createRequire(import.meta.url);

// ── Types ──────────────────────────────────────────────────────────────────────

export interface GmailConnection {
	id: string;
	status: "ACTIVE" | "INITIATED" | "EXPIRED" | "FAILED" | "INACTIVE";
	toolkit: {
		slug: string;
		name: string;
	};
	integration?: {
		name: string;
	};
	createdAt?: string;
}

export interface EmailMessage {
	id: string;
	threadId: string;
	subject: string;
	from: string;
	to: string;
	date: string;
	snippet: string;
	body?: string;
	isRead: boolean;
	labelIds: string[];
}

export interface TaskItem {
	task: string;
	priority: "high" | "medium" | "low";
	from: string;
	subject: string;
	context?: string;
}

export interface DigestResult {
	date: string;
	emailCount: number;
	taskCount: number;
	greeting: string;
	highPriority: TaskItem[];
	mediumPriority: TaskItem[];
	lowPriority: TaskItem[];
	closing: string;
}

// ── Composio Client (lazy loaded) ──────────────────────────────────────────────

let composioClient: any = null;

function getComposioClient(): any {
	if (!composioClient) {
		if (!process.env.COMPOSIO_API_KEY) {
			throw new Error("COMPOSIO_API_KEY belum diset. Tambahkan ke ~/.zshrc lalu restart pi.");
		}
		const Composio = require("@composio/core").Composio;
		composioClient = new Composio({
			apiKey: process.env.COMPOSIO_API_KEY,
		});
	}
	return composioClient;
}

// ── Connection Management ──────────────────────────────────────────────────────

export async function listGmailConnections(userId: string): Promise<GmailConnection[]> {
	const client = getComposioClient();

	let response: any;
	try {
		response = await client.connectedAccounts.list({
			userIds: [userId],
			toolkitSlugs: ["gmail"],
		});
	} catch (error: any) {
		throw new Error(`Gagal cek koneksi Gmail di Composio: ${error.message}`);
	}

	return (response.items || []).map((acc: any) => ({
		id: acc.id,
		status: acc.status,
		toolkit: {
			slug: acc.toolkit?.slug || "gmail",
			name: acc.toolkit?.name || "Gmail",
		},
		integration: {
			name: acc.integration?.name || acc.toolkit?.name || "Gmail",
		},
		createdAt: acc.createdAt || acc.created_at,
	}));
}

async function findOrCreateAuthConfig(client: any, toolkitSlug: string): Promise<string> {
	const authConfigs = await client.authConfigs.list({ toolkit: toolkitSlug });

	const existingConfig = (authConfigs.items || [])[0];
	if (existingConfig?.id) {
		return existingConfig.id;
	}

	const authConfig = await client.authConfigs.create(toolkitSlug, {
		type: "use_composio_managed_auth",
		name: `${toolkitSlug} Morning Coffee`,
	});

	return authConfig.id;
}

export async function initiateGmailConnection(
	userId: string
): Promise<{ redirectUrl: string; connectedAccountId: string }> {
	const client = getComposioClient();

	const authConfigId = await findOrCreateAuthConfig(client, "gmail");

	// `link` is the supported path for Composio-managed OAuth
	// (the legacy create/initiate endpoint is being retired for managed auth).
	const request = await client.connectedAccounts.link(userId, authConfigId);

	const redirectUrl = request.redirectUrl || request.redirect_url || "";
	if (!redirectUrl) {
		throw new Error("Composio gak ngasih OAuth URL. Cek dashboard Composio kamu.");
	}

	return {
		redirectUrl,
		connectedAccountId: request.id,
	};
}

export async function waitForConnection(
	connectedAccountId: string,
	timeoutMs: number = 120_000
): Promise<GmailConnection | null> {
	const client = getComposioClient();

	try {
		const account = await client.connectedAccounts.waitForConnection(
			connectedAccountId,
			timeoutMs
		);

		return {
			id: account.id,
			status: "ACTIVE",
			toolkit: {
				slug: account.toolkit?.slug || "gmail",
				name: account.toolkit?.name || "Gmail",
			},
			integration: {
				name: account.toolkit?.name || "Gmail",
			},
		};
	} catch {
		// Timed out or the connection ended up FAILED/EXPIRED
		return null;
	}
}

// ── Email Fetching via Composio Tools ──────────────────────────────────────────

export async function fetchTodayEmails(
	connectedAccountId: string,
	userId: string,
	maxResults: number = 20
): Promise<EmailMessage[]> {
	const client = getComposioClient();

	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const todayStr = today.toISOString().split("T")[0];

	let result: any;
	try {
		result = await client.tools.execute("GMAIL_FETCH_EMAILS", {
			userId,
			connectedAccountId,
			// Without this the SDK refuses to run with the "latest" toolkit
			// version (ComposioToolVersionRequiredError). Pinning a version
			// would be the production alternative, but for a personal digest
			// tracking latest is what we want.
			dangerouslySkipVersionCheck: true,
			arguments: {
				query: `in:inbox after:${todayStr}`,
				max_results: maxResults,
			},
		});
	} catch (error: any) {
		throw new Error(`Gagal fetch email dari Gmail: ${error.message}`);
	}

	if (!result.successful) {
		throw new Error(`Gmail fetch gagal: ${result.error || "unknown error dari Composio"}`);
	}

	const emails: EmailMessage[] = [];
	const messages = result.data?.messages || result.data?.result?.messages || [];

	for (const msg of messages) {
		emails.push({
			id: msg.id || msg.messageId,
			threadId: msg.threadId || msg.thread_id || "",
			subject:
				msg.subject ||
				msg.payload?.headers?.find((h: any) => h.name === "Subject")?.value ||
				"(Tanpa Subject)",
			from:
				msg.from ||
				msg.sender ||
				msg.payload?.headers?.find((h: any) => h.name === "From")?.value ||
				"Unknown",
			to: msg.to || "",
			date: msg.date || msg.messageTimestamp || msg.internalDate || "",
			snippet: msg.snippet || msg.preview?.body || "",
			body: msg.messageText || msg.body || msg.payload?.body?.data || "",
			isRead: !msg.labelIds?.includes("UNREAD"),
			labelIds: msg.labelIds || [],
		});
	}

	return emails;
}

// ── JSON Parsing for Agent Output ──────────────────────────────────────────────

export function parseTaskJson(output: string): DigestResult {
	// Try to extract JSON from the output (handle markdown code blocks)
	let jsonStr = output;

	const jsonMatch = output.match(/```json\s*([\s\S]*?)```/);
	if (jsonMatch) {
		jsonStr = jsonMatch[1].trim();
	} else {
		const rawMatch = output.match(/\{[\s\S]*\}/);
		if (rawMatch) {
			jsonStr = rawMatch[0];
		}
	}

	let parsed: any;
	try {
		parsed = JSON.parse(jsonStr);
	} catch {
		throw new Error(
			`Output agent bukan JSON valid. Awalnya: "${output.slice(0, 200)}"`
		);
	}

	const highPriority = (parsed.highPriority || []).map((t: any) => normalizeTask(t, "high"));
	const mediumPriority = (parsed.mediumPriority || []).map((t: any) => normalizeTask(t, "medium"));
	const lowPriority = (parsed.lowPriority || []).map((t: any) => normalizeTask(t, "low"));

	return {
		date: parsed.date || new Date().toISOString().split("T")[0],
		emailCount: parsed.emailCount || 0,
		// Count tasks ourselves — models miscount.
		taskCount: highPriority.length + mediumPriority.length + lowPriority.length,
		greeting: parsed.greeting || "Selamat pagi! Siap mulai hari ini?",
		highPriority,
		mediumPriority,
		lowPriority,
		closing: parsed.closing || "Semangat! 🚀",
	};
}

function normalizeTask(t: any, priority: TaskItem["priority"]): TaskItem {
	return {
		task: t.task || t.description || "",
		priority: t.priority || priority,
		from: t.from || t.sender || "",
		subject: t.subject || "",
		context: t.context || t.details || "",
	};
}

// ── Markdown Formatting ────────────────────────────────────────────────────────

export function formatDigestMarkdown(digest: DigestResult): string {
	const lines: string[] = [];

	lines.push(`## ${digest.greeting}`);
	lines.push("");

	if (digest.highPriority.length > 0) {
		lines.push("### 🔴 Wajib Hari Ini");
		for (const task of digest.highPriority) {
			lines.push(`- [ ] **${task.task}**`);
			if (task.from) lines.push(`  - Dari: ${task.from}`);
			if (task.subject) lines.push(`  - Subject: ${task.subject}`);
			if (task.context) lines.push(`  - 💡 ${task.context}`);
		}
		lines.push("");
	}

	if (digest.mediumPriority.length > 0) {
		lines.push("### 🟡 Minggu Ini");
		for (const task of digest.mediumPriority) {
			lines.push(`- [ ] **${task.task}**`);
			if (task.from) lines.push(`  - Dari: ${task.from}`);
			if (task.subject) lines.push(`  - Subject: ${task.subject}`);
			if (task.context) lines.push(`  - 💡 ${task.context}`);
		}
		lines.push("");
	}

	if (digest.lowPriority.length > 0) {
		lines.push("### 🟢 Santai Aja");
		for (const task of digest.lowPriority) {
			lines.push(`- [ ] **${task.task}**`);
			if (task.from) lines.push(`  - Dari: ${task.from}`);
		}
		lines.push("");
	}

	lines.push("---");
	lines.push(`*${digest.closing}*`);
	lines.push("");
	lines.push(`📊 ${digest.taskCount} task dari ${digest.emailCount} email hari ini`);

	return lines.join("\n");
}

// ── Email Data Serialization for Agent ─────────────────────────────────────────

export function serializeEmailsForAgent(emails: EmailMessage[]): string {
	return emails
		.map((e, i) => {
			const lines = [
				`[Email ${i + 1}]`,
				`Subject: ${e.subject}`,
				`From: ${e.from}`,
				`Date: ${e.date}`,
				`Snippet: ${e.snippet}`,
			];
			if (e.body) lines.push(`Body: ${e.body.slice(0, 1500)}`);
			return lines.join("\n");
		})
		.join("\n\n");
}

// ── User ID Generation ─────────────────────────────────────────────────────────

export function getUserId(): string {
	// Stable per-machine user ID. Keeps the old "morning-digest" prefix so
	// existing Composio connections keep working after the rename.
	return `morning-digest-${hostname().slice(0, 15)}`;
}
