/**
 * Slack Reply Lib — Helpers for the slack-reply pipeline
 *
 * Provides:
 * - Slack permalink parsing
 * - Composio SDK integration for Slack (@composio/core v0.10)
 * - Channel→repo config load/save
 * - gh multi-account helpers and repo clone cache
 * - Thread transcript serialization
 *
 * Errors are propagated (not swallowed) so the pipeline can show the real
 * cause. Pure functions live here so they're testable without Composio/gh.
 */

import { createRequire } from "module";
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { hostname } from "os";

const require = createRequire(import.meta.url);

// ── Slack URL Parsing ──────────────────────────────────────────────────────────

export interface SlackMessageRef {
	channelId: string;
	/** Message timestamp, e.g. "1718200000.123456" */
	messageTs: string;
	/** Root thread ts when the URL points to a reply inside a thread */
	threadTs?: string;
}

export function parseSlackUrl(url: string): SlackMessageRef {
	let u: URL;
	try {
		u = new URL(url.trim());
	} catch {
		throw new Error(`Not a valid URL: ${url}`);
	}

	if (!u.hostname.endsWith(".slack.com")) {
		throw new Error(`Not a Slack URL (host: ${u.hostname})`);
	}

	const m = u.pathname.match(/^\/archives\/([A-Z0-9]+)\/p(\d{16})$/);
	if (!m) {
		throw new Error(
			`Unrecognized Slack message URL path: ${u.pathname} — expected /archives/<CHANNEL>/p<16 digits>`,
		);
	}

	const raw = m[2];
	return {
		channelId: m[1],
		messageTs: `${raw.slice(0, 10)}.${raw.slice(10)}`,
		threadTs: u.searchParams.get("thread_ts") || undefined,
	};
}

// ── Thread Transcript ──────────────────────────────────────────────────────────

export interface SlackMessage {
	ts: string;
	user: string;
	text: string;
}

/** Normalize a raw Composio/Slack message object into our shape. */
export function normalizeSlackMessage(raw: any): SlackMessage {
	const r = raw || {};
	return {
		ts: r.ts || "",
		user: r.user || r.username || r.bot_id || "unknown",
		text: r.text || "",
	};
}

function tsToIso(ts: string): string {
	const seconds = parseFloat(ts);
	if (!Number.isFinite(seconds)) return ts;
	return new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 16);
}

/**
 * Serialize a thread for sub-agent prompts. The target message (the one the
 * URL pointed at — the one we're answering) is marked explicitly.
 */
export function serializeThread(messages: SlackMessage[], targetTs: string): string {
	if (!messages.some((m) => m.ts === targetTs)) {
		throw new Error(`Target message ts ${targetTs} not found in thread (${messages.length} messages)`);
	}
	return messages
		.map((m, i) => {
			const marker = m.ts === targetTs ? "\n>>> TARGET MESSAGE (answer this one)" : "";
			return `[${i + 1}] ${m.user} (${tsToIso(m.ts)}):${marker}\n${m.text}`;
		})
		.join("\n\n");
}

// ── Agent Output Parsing ───────────────────────────────────────────────────────

/**
 * Strip a single wrapping code fence some models add around the whole reply.
 * Inner fences (actual code in the reply) are preserved.
 */
export function cleanDraft(output: string): string {
	const t = output.trim();
	const fence = t.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
	// Only unwrap when the closing fence is the LAST fence marker — otherwise
	// the draft legitimately contains code blocks.
	if (fence && !fence[1].includes("```")) return fence[1].trim();
	return t;
}

export interface RepoCandidate {
	repo: string;
	reason: string;
}

export function parseRepoCandidates(output: string): RepoCandidate[] {
	let jsonStr = output;
	const jsonMatch = output.match(/```json\s*([\s\S]*?)```/);
	if (jsonMatch) {
		jsonStr = jsonMatch[1].trim();
	} else {
		const rawMatch = output.match(/[\[\{][\s\S]*[\]\}]/);
		if (rawMatch) jsonStr = rawMatch[0];
	}

	let parsed: any;
	try {
		parsed = JSON.parse(jsonStr);
	} catch {
		throw new Error(`Resolver output is not valid JSON. It began with: "${output.slice(0, 150)}"`);
	}

	const candidates = Array.isArray(parsed) ? parsed : parsed.candidates;
	if (!Array.isArray(candidates) || candidates.length === 0) {
		throw new Error("Resolver returned no candidates");
	}
	return candidates.map((c: any) => {
		if (!c.repo || typeof c.repo !== "string") {
			throw new Error(`Candidate missing repo field: ${JSON.stringify(c)}`);
		}
		return { repo: c.repo, reason: typeof c.reason === "string" ? c.reason : "" };
	});
}

// ── Channel → Repo Config ──────────────────────────────────────────────────────

export interface ChannelMapping {
	/** "owner/name" */
	repo: string;
	/** gh CLI account that can access the repo */
	ghAccount: string;
}

export interface SlackReplyConfig {
	channels: Record<string, ChannelMapping>;
}

export function loadConfig(path: string): SlackReplyConfig {
	if (!existsSync(path)) return { channels: {} };
	let parsed: any;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err: any) {
		// A corrupt config silently treated as empty would re-trigger the LLM
		// fallback and overwrite the file — fail loudly instead.
		throw new Error(`Corrupt config at ${path}: ${err.message}`);
	}
	return { channels: parsed.channels || {} };
}

export function saveChannelMapping(path: string, channel: string, mapping: ChannelMapping): void {
	const config = loadConfig(path);
	config.channels[channel] = mapping;
	writeFileSync(path, JSON.stringify(config, null, "\t") + "\n", "utf-8");
}

// ── gh Multi-Account Helpers ───────────────────────────────────────────────────
// The exec wrappers are thin and untested; the parsing is pure and tested.

function gh(args: string[]): string {
	return execFileSync("gh", args, {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

export interface GhAccounts {
	accounts: string[];
	active: string | null;
}

export function parseGhAccounts(statusOutput: string): GhAccounts {
	const accounts: string[] = [];
	let active: string | null = null;
	const lines = statusOutput.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/Logged in to \S+ account (\S+)/);
		if (!m) continue;
		accounts.push(m[1]);
		if (lines[i + 1]?.includes("Active account: true")) active = m[1];
	}
	return { accounts, active };
}

export function listGhAccounts(): GhAccounts {
	// gh auth status exits 1 when some hosts have problems but still prints
	// the account list — capture output either way.
	let out = "";
	try {
		out = gh(["auth", "status"]);
	} catch (err: any) {
		out = (err.stdout || "") + "\n" + (err.stderr || "");
	}
	return parseGhAccounts(out);
}

export function switchGhAccount(account: string): void {
	gh(["auth", "switch", "-u", account]);
}

/**
 * Restore the previously active gh account from a finally block without
 * masking the original error. If no account was active (gh sometimes
 * reports none), there is nothing to restore — the session stays on the
 * last-switched account. A failed restore is reported loudly on stderr
 * instead of thrown, so it never swallows the error that triggered it.
 */
function restoreGhAccount(active: string | null): void {
	if (!active) return;
	try {
		switchGhAccount(active);
	} catch (err: any) {
		console.error(
			`WARNING: could not restore gh account "${active}" (${err.message}). ` +
			`Run: gh auth switch -u ${active}`,
		);
	}
}

export interface RepoListing {
	repo: string;
	description: string;
	ghAccount: string;
}

/**
 * List repos visible to each logged-in gh account. Switches accounts to do
 * so; restores the previously active account afterwards.
 */
export function listAllRepos(): RepoListing[] {
	const { accounts, active } = listGhAccounts();
	if (accounts.length === 0) throw new Error("No gh accounts logged in — run `gh auth login`");

	const listings: RepoListing[] = [];
	try {
		for (const account of accounts) {
			switchGhAccount(account);
			const raw = gh(["repo", "list", "--limit", "200", "--json", "nameWithOwner,description"]);
			for (const r of JSON.parse(raw)) {
				listings.push({ repo: r.nameWithOwner, description: r.description || "", ghAccount: account });
			}
		}
	} finally {
		restoreGhAccount(active);
	}
	return listings;
}

// ── Repo Clone Cache ───────────────────────────────────────────────────────────

export function repoCachePath(repo: string, cacheRoot: string): string {
	return join(cacheRoot, repo.replaceAll("/", "__"));
}

/**
 * Clone the repo into the cache (or pull if already cloned) using the given
 * gh account. Always restores the previously active account, even on failure.
 * Returns the local checkout path.
 */
export function syncRepo(repo: string, ghAccount: string, cacheRoot: string): string {
	const dir = repoCachePath(repo, cacheRoot);
	const { active } = listGhAccounts();

	try {
		switchGhAccount(ghAccount);
		if (existsSync(join(dir, ".git"))) {
			try {
				execFileSync("git", ["-C", dir, "pull", "--ff-only"], {
					encoding: "utf-8",
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (err: any) {
				throw new Error(
					`git pull failed for ${dir} (${err.stderr || err.message}). ` +
					`If the cache is stale, delete the directory and re-run.`,
				);
			}
		} else {
			mkdirSync(cacheRoot, { recursive: true });
			gh(["repo", "clone", repo, dir, "--", "--depth", "50"]);
		}
	} finally {
		if (active !== ghAccount) restoreGhAccount(active);
	}
	return dir;
}

export const DEFAULT_CACHE_ROOT = join(
	process.env.HOME || "~",
	".cache", "slack-reply", "repos",
);

// ── Composio Client (lazy loaded) ──────────────────────────────────────────────

let composioClient: any = null;

function getComposioClient(): any {
	if (!composioClient) {
		if (!process.env.COMPOSIO_API_KEY) {
			throw new Error("COMPOSIO_API_KEY is not set. Add it to ~/.zshrc and restart pi.");
		}
		const Composio = require("@composio/core").Composio;
		composioClient = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
	}
	return composioClient;
}

export function getUserId(): string {
	// Stable per-machine user ID, own prefix (separate from morning-coffee
	// connections).
	return `slack-reply-${hostname().slice(0, 15)}`;
}

// Composio tool slugs — verified against the live toolkit on 2026-06-12.
// SLACK_FETCH_CONVERSATION_REPLIES does NOT exist; the correct slug is
// SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION. If Composio renames a tool,
// this is the only place to update.
export const SLACK_TOOLS = {
	fetchReplies: "SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION",
	fetchHistory: "SLACK_FETCH_CONVERSATION_HISTORY",
	channelInfo: "SLACK_RETRIEVE_CONVERSATION_INFORMATION",
	sendMessage: "SLACK_SEND_MESSAGE",
};

// ── Connection Management ──────────────────────────────────────────────────────

export interface SlackConnection {
	id: string;
	status: "ACTIVE" | "INITIATED" | "EXPIRED" | "FAILED" | "INACTIVE";
	label: string;
}

export async function listSlackConnections(userId: string): Promise<SlackConnection[]> {
	const client = getComposioClient();
	let response: any;
	try {
		response = await client.connectedAccounts.list({
			userIds: [userId],
			toolkitSlugs: ["slack"],
		});
	} catch (error: any) {
		throw new Error(`Failed to check Slack connections in Composio: ${error.message}`);
	}
	return (response.items || []).map((acc: any) => ({
		id: acc.id,
		status: acc.status,
		label: acc.integration?.name || acc.toolkit?.name || "Slack",
	}));
}

export async function initiateSlackConnection(
	userId: string,
): Promise<{ redirectUrl: string; connectedAccountId: string }> {
	const client = getComposioClient();

	const authConfigs = await client.authConfigs.list({ toolkit: "slack" });
	let authConfigId = (authConfigs.items || [])[0]?.id;
	if (!authConfigId) {
		const created = await client.authConfigs.create("slack", {
			type: "use_composio_managed_auth",
			name: "slack Slack Reply",
		});
		authConfigId = created.id;
	}

	const request = await client.connectedAccounts.link(userId, authConfigId);
	const redirectUrl = request.redirectUrl || request.redirect_url || "";
	if (!redirectUrl) {
		throw new Error("Composio did not return an OAuth URL. Check your Composio dashboard.");
	}
	return { redirectUrl, connectedAccountId: request.id };
}

export async function waitForSlackConnection(
	connectedAccountId: string,
	timeoutMs: number = 120_000,
): Promise<SlackConnection | null> {
	const client = getComposioClient();
	try {
		const account = await client.connectedAccounts.waitForConnection(connectedAccountId, timeoutMs);
		return { id: account.id, status: "ACTIVE", label: account.toolkit?.name || "Slack" };
	} catch {
		return null; // timed out or FAILED/EXPIRED
	}
}

// ── Slack Calls via Composio Tools ─────────────────────────────────────────────

async function executeSlackTool(
	slug: string,
	connectedAccountId: string,
	userId: string,
	args: Record<string, any>,
): Promise<any> {
	const client = getComposioClient();
	let result: any;
	try {
		result = await client.tools.execute(slug, {
			userId,
			connectedAccountId,
			// Same trade-off as morning-coffee: track the latest toolkit
			// version instead of pinning.
			dangerouslySkipVersionCheck: true,
			arguments: args,
		});
	} catch (error: any) {
		throw new Error(`${slug} failed: ${error.message}`);
	}
	if (!result.successful) {
		throw new Error(`${slug} failed: ${result.error || "unknown error from Composio"}`);
	}
	return result.data;
}

/**
 * Fetch the full thread containing the referenced message. Falls back to
 * fetching just the single message when the thread lookup fails (e.g. a
 * standalone message in a channel).
 */
export async function fetchThread(
	connectedAccountId: string,
	userId: string,
	ref: SlackMessageRef,
): Promise<SlackMessage[]> {
	const rootTs = ref.threadTs ?? ref.messageTs;
	try {
		const data = await executeSlackTool(SLACK_TOOLS.fetchReplies, connectedAccountId, userId, {
			channel: ref.channelId,
			ts: rootTs,
			limit: 50,
		});
		const messages = (data?.messages || []).map(normalizeSlackMessage);
		if (messages.length === 0) throw new Error("thread lookup returned no messages");
		return messages;
	} catch (repliesErr: any) {
		// Standalone message — fetch just it from channel history. If the
		// thread call failed for another reason (auth, network), the history
		// call will fail too and bubble up; keep the original cause visible.
		const data = await executeSlackTool(SLACK_TOOLS.fetchHistory, connectedAccountId, userId, {
			channel: ref.channelId,
			latest: ref.messageTs,
			inclusive: true,
			limit: 1,
		});
		const messages = (data?.messages || []).map(normalizeSlackMessage);
		if (messages.length === 0) {
			throw new Error(
				`Message ${ref.messageTs} not found in channel ${ref.channelId}` +
				` (thread lookup also failed: ${repliesErr.message})`,
			);
		}
		return messages;
	}
}

export async function fetchChannelName(
	connectedAccountId: string,
	userId: string,
	channelId: string,
): Promise<string> {
	const data = await executeSlackTool(SLACK_TOOLS.channelInfo, connectedAccountId, userId, {
		channel: channelId,
	});
	return data?.channel?.name || channelId;
}

/** Post a reply into the thread. Returns the new message ts. */
export async function postReply(
	connectedAccountId: string,
	userId: string,
	channelId: string,
	threadTs: string,
	text: string,
): Promise<string> {
	const data = await executeSlackTool(SLACK_TOOLS.sendMessage, connectedAccountId, userId, {
		channel: channelId,
		text,
		thread_ts: threadTs,
	});
	return data?.ts || data?.message?.ts || "";
}
