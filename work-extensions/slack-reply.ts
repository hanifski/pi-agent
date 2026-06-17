/**
 * Slack Reply — Slack message URL → repo-grounded reply pipeline
 *
 * Reads a Slack message URL (via Composio), finds the related GitHub repo
 * (config map with LLM fallback), clones/pulls it into a local cache,
 * analyzes the codebase with a sub-agent, drafts a reply matching the
 * thread's language, and — after explicit user approval — posts it back
 * into the Slack thread.
 *
 * Pipeline: Slack Fetch → Repo Resolve → Repo Sync → Analyze → Draft & Post
 *
 * Usage: pi -e ~/agency-tools/extensions/slack-reply.ts
 * Or:    /slack-reply <slack-message-url>
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import * as os from "os";
import {
	type SlackMessageRef,
	type SlackMessage,
	type SlackConnection,
	type ChannelMapping,
	parseSlackUrl,
	serializeThread,
	cleanDraft,
	parseRepoCandidates,
	loadConfig,
	saveChannelMapping,
	listAllRepos,
	syncRepo,
	DEFAULT_CACHE_ROOT,
	getUserId,
	listSlackConnections,
	initiateSlackConnection,
	waitForSlackConnection,
	fetchThread,
	fetchChannelName,
	postReply,
} from "./slack-reply-lib.ts";

// ── Types ──────────────────────────────────────────────────────────────────────

interface StepState {
	label: string;
	status: "idle" | "running" | "done" | "error";
	elapsed: number;
	lastWork: string;
}

// ── Pipeline Steps ──────────────────────────────────────────────────────────────

const PIPELINE_STEPS: StepState[] = [
	{ label: "Slack Fetch",  status: "idle", elapsed: 0, lastWork: "" },
	{ label: "Repo Resolve", status: "idle", elapsed: 0, lastWork: "" },
	{ label: "Repo Sync",    status: "idle", elapsed: 0, lastWork: "" },
	{ label: "Analyze",      status: "idle", elapsed: 0, lastWork: "" },
	{ label: "Draft & Post", status: "idle", elapsed: 0, lastWork: "" },
];

// ── Agent Runner ───────────────────────────────────────────────────────────────

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(EXTENSION_DIR, "slack-reply.config.json");

function loadAgentDef(agentName: string, cwd: string): { systemPrompt: string; tools: string } {
	const candidates = [
		join(cwd, "agents", `${agentName}.md`),
		join(EXTENSION_DIR, "agents", `${agentName}.md`),
		join(os.homedir(), ".pi", "agent", "agents", `${agentName}.md`),
	];

	const agentFile = candidates.find(existsSync);
	if (!agentFile) {
		throw new Error(`Agent "${agentName}" not found. Looked in:\n  ${candidates.join("\n  ")}`);
	}

	const raw = readFileSync(agentFile, "utf-8");
	const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) throw new Error(`Invalid frontmatter in ${agentFile}`);

	const frontmatter: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}

	return {
		systemPrompt: match[2].trim(),
		tools: frontmatter.tools?.trim() || "",
	};
}

interface SpawnOptions {
	onChunk?: (text: string) => void;
	/** Working directory for the subprocess — the analyst runs inside the repo clone. */
	spawnCwd?: string;
}

function spawnPiAgent(
	agentName: string,
	prompt: string,
	cwd: string,
	ctx: any,
	options: SpawnOptions = {},
): Promise<string> {
	const def = loadAgentDef(agentName, cwd);
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "openrouter/google/gemini-3-flash-preview";

	return new Promise((resolve, reject) => {
		const proc = spawn("pi", [
			"--mode", "json",
			"-p",
			"--no-extensions",
			"--model", model,
			"--tools", def.tools,
			"--thinking", "off",
			"--append-system-prompt", def.systemPrompt,
			prompt,
		], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env },
			cwd: options.spawnCwd,
		});

		const textChunks: string[] = [];
		let buffer = "";

		proc.stdout!.setEncoding("utf-8");
		proc.stdout!.on("data", (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line);
					if (event.type === "message_update") {
						const delta = event.assistantMessageEvent;
						if (delta?.type === "text_delta") {
							const text = delta.delta || "";
							textChunks.push(text);
							if (options.onChunk) options.onChunk(text);
						}
					}
				} catch {}
			}
		});

		proc.stderr!.setEncoding("utf-8");
		proc.stderr!.on("data", () => {});

		proc.on("close", (code: number | null) => {
			if (buffer.trim()) {
				try {
					const event = JSON.parse(buffer);
					if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
						textChunks.push(event.assistantMessageEvent.delta || "");
					}
				} catch {}
			}
			if (code === 0) resolve(textChunks.join(""));
			else reject(new Error(`Agent "${agentName}" exited with code ${code}`));
		});

		proc.on("error", (err: Error) => reject(err));
	});
}

// ── Widget ─────────────────────────────────────────────────────────────────────

let stepStates: StepState[] = PIPELINE_STEPS.map((s) => ({ ...s }));
let widgetCtx: any = null;
let headerLabel = "";

function resetSteps() {
	stepStates = PIPELINE_STEPS.map((s) => ({ ...s }));
	headerLabel = "";
}

function renderCard(state: StepState, colWidth: number, theme: any): string[] {
	const w = colWidth - 2;
	const truncate = (s: string, max: number) => (s.length > max ? s.slice(0, max - 3) + "..." : s);

	const statusColor =
		state.status === "idle" ? "dim"
		: state.status === "running" ? "accent"
		: state.status === "done" ? "success"
		: "error";

	const statusIcon =
		state.status === "idle" ? "○"
		: state.status === "running" ? "●"
		: state.status === "done" ? "✓"
		: "✗";

	const nameStr = theme.fg("accent", theme.bold(truncate(state.label, w)));
	const nameVis = Math.min(state.label.length, w);

	const timeStr = state.status !== "idle" ? ` ${Math.round(state.elapsed / 1000)}s` : "";
	const statusStr = `${statusIcon} ${state.status}${timeStr}`;
	const statusLine = theme.fg(statusColor, statusStr);
	const statusVis = statusStr.length;

	const workRaw = state.lastWork || "";
	const workText = workRaw ? truncate(workRaw, Math.min(50, w - 1)) : "";
	const workLine = workText ? theme.fg("muted", workText) : theme.fg("dim", "—");
	const workVis = workText ? workText.length : 1;

	const border = (content: string, visLen: number) =>
		theme.fg("dim", "│") + content + " ".repeat(Math.max(0, w - visLen)) + theme.fg("dim", "│");

	return [
		theme.fg("dim", "┌" + "─".repeat(w) + "┐"),
		border(" " + nameStr, 1 + nameVis),
		border(" " + statusLine, 1 + statusVis),
		border(" " + workLine, 1 + workVis),
		theme.fg("dim", "└" + "─".repeat(w) + "┘"),
	];
}

function updateWidget() {
	if (!widgetCtx) return;

	widgetCtx.ui.setWidget("slack-reply", (_tui: any, theme: any) => {
		const text = new Text("", 0, 1);

		return {
			render(width: number): string[] {
				const arrowWidth = 5;
				const cols = stepStates.length;
				const colWidth = Math.max(14, Math.floor((width - arrowWidth * (cols - 1)) / cols));
				const arrowRow = 2;

				const cards = stepStates.map((s) => renderCard(s, colWidth, theme));
				const cardHeight = cards[0].length;
				const outputLines: string[] = [];

				outputLines.push(theme.fg("accent", theme.bold(` 💬 Slack Reply${headerLabel ? " — " + headerLabel : ""}`)));
				outputLines.push("");

				for (let line = 0; line < cardHeight; line++) {
					let row = cards[0][line];
					for (let c = 1; c < cols; c++) {
						row += line === arrowRow ? theme.fg("dim", " ──▶ ") : " ".repeat(arrowWidth);
						row += cards[c][line];
					}
					outputLines.push(row);
				}

				text.setText(outputLines.join("\n"));
				return text.render(width);
			},
			invalidate() {
				text.invalidate();
			},
		};
	});
}

// ── Step Runner (generic over step result, from morning-coffee.ts) ─────────────

async function runStep<T>(
	stepIndex: number,
	action: () => Promise<T>,
	summarize: (result: T) => string,
): Promise<T> {
	const state = stepStates[stepIndex];
	const start = Date.now();
	state.status = "running";
	state.elapsed = 0;
	state.lastWork = "";
	updateWidget();

	const timer = setInterval(() => {
		state.elapsed = Date.now() - start;
		updateWidget();
	}, 1000);

	try {
		const result = await action();
		state.status = "done";
		state.elapsed = Date.now() - start;
		state.lastWork = summarize(result);
		updateWidget();
		return result;
	} catch (err) {
		state.status = "error";
		state.elapsed = Date.now() - start;
		state.lastWork = (err as Error).message;
		updateWidget();
		throw err;
	} finally {
		clearInterval(timer);
	}
}

function onChunkFor(stepIndex: number) {
	return (chunk: string) => {
		const state = stepStates[stepIndex];
		const accumulated = state.lastWork + chunk;
		state.lastWork = accumulated.split("\n").filter((l) => l.trim()).pop() || "";
		updateWidget();
	};
}

// ── Stage Logging ──────────────────────────────────────────────────────────────

function makeRunLogger(cwd: string) {
	const dir = join(cwd, ".pi", "slack-reply-logs", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
	try { mkdirSync(dir, { recursive: true }); } catch {}
	return {
		dir,
		log(name: string, content: string) {
			try { writeFileSync(join(dir, name), content, "utf-8"); } catch {}
		},
	};
}

// ── Connection Management ──────────────────────────────────────────────────────

async function ensureSlackConnection(userId: string, ctx: any): Promise<SlackConnection> {
	const connections = await listSlackConnections(userId);
	const active = connections.filter((c) => c.status === "ACTIVE");

	if (active.length > 0) return active[0];

	if (!ctx.hasUI) {
		throw new Error("No Slack connection. Run in interactive mode to set one up.");
	}

	stepStates[0].lastWork = "No connection — setting up...";
	updateWidget();

	const result = await initiateSlackConnection(userId);
	ctx.ui.notify(`🔗 Open this link to connect Slack:\n${result.redirectUrl}`, "info");

	stepStates[0].lastWork = "Waiting for authorization...";
	updateWidget();

	const connection = await waitForSlackConnection(result.connectedAccountId);
	if (!connection) {
		throw new Error("Timed out waiting for Slack authorization. Try again.");
	}
	return connection;
}

// ── Repo Resolution ────────────────────────────────────────────────────────────

const MANUAL_ENTRY = "✏️  Type owner/repo manually";

async function resolveRepo(
	channelName: string,
	transcript: string,
	cwd: string,
	ctx: any,
): Promise<ChannelMapping> {
	const config = loadConfig(CONFIG_PATH);
	const mapped = config.channels[channelName];
	if (mapped) return mapped;

	if (!ctx.hasUI) {
		throw new Error(
			`Channel "${channelName}" is not mapped in ${CONFIG_PATH} — run interactively or add the mapping.`,
		);
	}

	// LLM fallback: propose candidates from all accounts' repo lists.
	stepStates[1].lastWork = "listing repos across gh accounts...";
	updateWidget();
	const listings = listAllRepos();
	const byRepo = new Map(listings.map((l) => [l.repo, l]));

	const repoList = listings
		.map((l) => `- ${l.repo} [account: ${l.ghAccount}]${l.description ? ` — ${l.description}` : ""}`)
		.join("\n");
	const prompt = `Slack channel: #${channelName}\n\nThread transcript:\n${transcript}\n\n---REPOS---\n${repoList}`;

	stepStates[1].lastWork = "asking resolver agent...";
	updateWidget();

	let candidates: { repo: string; reason: string }[] = [];
	try {
		let output = await spawnPiAgent("slack-reply-repo-resolver", prompt, cwd, ctx);
		try {
			candidates = parseRepoCandidates(output);
		} catch (err: any) {
			output = await spawnPiAgent(
				"slack-reply-repo-resolver",
				`${prompt}\n\n<format-violation>Your previous response was invalid: ${err.message}\nDo NOT ask questions. Output ONLY the required JSON, starting now.</format-violation>`,
				cwd, ctx,
			);
			candidates = parseRepoCandidates(output);
		}
	} catch (err: any) {
		// Degrade to manual selection, but say so.
		ctx.ui.notify(`Repo suggestions unavailable (${err.message}) — pick manually`, "warning");
	}

	// Drop hallucinated repos that aren't in the real list.
	candidates = candidates.filter((c) => byRepo.has(c.repo));

	const choices = [
		...candidates.map((c) => `${c.repo} — ${c.reason}`),
		MANUAL_ENTRY,
	];
	const selected = await ctx.ui.select(`Which repo is #${channelName} about?`, choices);
	if (selected === undefined) throw new Error("Repo selection cancelled");

	let mapping: ChannelMapping;
	if (selected === MANUAL_ENTRY) {
		const typed = (await ctx.ui.input("Repo (owner/name):", ""))?.trim();
		if (!typed || !typed.includes("/")) throw new Error(`Invalid repo: "${typed}"`);
		const known = byRepo.get(typed);
		let ghAccount = known?.ghAccount;
		if (!ghAccount) {
			const accounts = [...new Set(listings.map((l) => l.ghAccount))];
			ghAccount = await ctx.ui.select(`Which gh account can access ${typed}?`, accounts);
			if (!ghAccount) throw new Error("No gh account selected");
		}
		mapping = { repo: typed, ghAccount };
	} else {
		const repo = selected.split(" — ")[0];
		mapping = { repo, ghAccount: byRepo.get(repo)!.ghAccount };
	}

	// Write back so this channel is deterministic next time.
	saveChannelMapping(CONFIG_PATH, channelName, mapping);
	ctx.ui.notify(`Saved mapping: #${channelName} → ${mapping.repo} (${CONFIG_PATH})`, "info");
	return mapping;
}

// ── Core Pipeline ──────────────────────────────────────────────────────────────

interface PipelineResult {
	channelName: string;
	repo: string;
	draftPath: string;
	posted: boolean;
	replyTs?: string;
}

async function runPipeline(url: string, cwd: string, ctx: any): Promise<PipelineResult> {
	const logger = makeRunLogger(cwd);
	try {
		return await runPipelineInner(url, cwd, ctx, logger);
	} catch (err: any) {
		throw new Error(`${err.message}\n(stage logs: ${logger.dir})`);
	}
}

async function runPipelineInner(
	url: string,
	cwd: string,
	ctx: any,
	logger: ReturnType<typeof makeRunLogger>,
): Promise<PipelineResult> {
	resetSteps();
	updateWidget();

	const ref: SlackMessageRef = parseSlackUrl(url);
	const userId = getUserId();

	// Step 1 — Slack Fetch
	const fetched = await runStep(
		0,
		async () => {
			const connection = await ensureSlackConnection(userId, ctx);
			const [messages, channelName] = await Promise.all([
				fetchThread(connection.id, userId, ref),
				fetchChannelName(connection.id, userId, ref.channelId),
			]);
			return { connection, messages, channelName };
		},
		(r) => `#${r.channelName}: ${r.messages.length} messages`,
	);

	headerLabel = `#${fetched.channelName}`;
	updateWidget();

	const transcript = serializeThread(fetched.messages, ref.messageTs);
	logger.log("1-transcript.md", transcript);

	// Step 2 — Repo Resolve
	const mapping = await runStep(
		1,
		() => resolveRepo(fetched.channelName, transcript, cwd, ctx),
		(m) => `${m.repo} (${m.ghAccount})`,
	);

	// Step 3 — Repo Sync
	const repoDir = await runStep(
		2,
		async () => syncRepo(mapping.repo, mapping.ghAccount, DEFAULT_CACHE_ROOT),
		(dir) => `synced → ${dir.replace(os.homedir(), "~")}`,
	);

	// Step 4 — Analyze (sub-agent runs INSIDE the repo clone)
	const findings = await runStep(
		3,
		async () => {
			const prompt = `Answer the target message in this Slack thread by investigating the codebase (your cwd):\n\n${transcript}`;
			let output = await spawnPiAgent("slack-reply-analyst", prompt, cwd, ctx, {
				onChunk: onChunkFor(3),
				spawnCwd: repoDir,
			});
			if (!output.includes("ANSWER:")) {
				output = await spawnPiAgent(
					"slack-reply-analyst",
					`${prompt}\n\n<format-violation>Your previous response was missing the ANSWER:/EVIDENCE:/UNKNOWNS: structure. Output the required structure now.</format-violation>`,
					cwd, ctx,
					{ onChunk: onChunkFor(3), spawnCwd: repoDir },
				);
				if (!output.includes("ANSWER:")) throw new Error("Analyst did not produce ANSWER section");
			}
			return output;
		},
		() => "findings ready",
	);

	logger.log("4-analyst.md", findings);

	// Step 5 — Draft & Post (confirm gate — NEVER auto-post)
	const result = await runStep(
		4,
		async () => {
			const draftPrompt = (extra: string) =>
				`Slack thread:\n${transcript}\n\n---FINDINGS---\n${findings}${extra}`;

			let draft = cleanDraft(
				await spawnPiAgent("slack-reply-drafter", draftPrompt(""), cwd, ctx, { onChunk: onChunkFor(4) }),
			);
			logger.log("5-draft.md", draft);

			const slug = `${fetched.channelName}-${ref.messageTs.replace(".", "-")}`;
			const draftPath = join(cwd, `slack-reply-${slug}.md`);

			if (!ctx.hasUI) {
				writeFileSync(draftPath, draft, "utf-8");
				throw new Error(`No UI — refusing to post without confirmation. Draft saved: ${draftPath}`);
			}

			// Post / Edit / Cancel loop
			while (true) {
				writeFileSync(draftPath, draft, "utf-8");
				ctx.ui.notify(`Draft reply:\n\n${draft}`, "info");
				const action = await ctx.ui.select(
					`Post this reply to #${fetched.channelName}?`,
					["Post", "Edit", "Cancel"],
				);

				if (action === "Post") {
					const threadTs = ref.threadTs ?? ref.messageTs;
					const replyTs = await postReply(
						fetched.connection.id, userId, ref.channelId, threadTs, draft,
					);
					return { draftPath, posted: true, replyTs };
				}

				if (action === "Edit") {
					const instructions = await ctx.ui.input("Revision instructions:", "");
					if (!instructions?.trim()) continue;
					draft = cleanDraft(
						await spawnPiAgent(
							"slack-reply-drafter",
							draftPrompt(`\n\n---PREVIOUS DRAFT---\n${draft}\n\n---REVISION INSTRUCTIONS---\n${instructions}`),
							cwd, ctx, { onChunk: onChunkFor(4) },
						),
					);
					logger.log("5-draft.md", draft);
					continue;
				}

				// Cancel or dismissed
				return { draftPath, posted: false, replyTs: undefined };
			}
		},
		(r) => (r.posted ? "posted ✓" : "not posted (draft saved)"),
	);

	return {
		channelName: fetched.channelName,
		repo: mapping.repo,
		draftPath: result.draftPath,
		posted: result.posted,
		replyTs: result.replyTs,
	};
}

// ── Extension ──────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Tool: run_slack_reply ─────────────────────────────────────────────────

	pi.registerTool({
		name: "run_slack_reply",
		label: "Slack Reply 💬",
		description:
			"Given a Slack message URL, fetch the thread, find the related GitHub repo, analyze its codebase, and draft a reply. The user approves the draft before anything is posted to Slack.",

		parameters: Type.Object({
			url: Type.String({ description: "Slack message permalink (https://<ws>.slack.com/archives/<channel>/p<ts>)" }),
		}),

		async execute(_toolCallId: string, params: any, _signal: any, onUpdate: any, ctx: any) {
			widgetCtx = ctx;
			const { url } = params as { url: string };

			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: "Starting slack-reply pipeline..." }],
					details: { status: "running" },
				});
			}

			try {
				const result = await runPipeline(url, ctx.cwd, ctx);
				const summary = [
					`Channel: #${result.channelName}`,
					`Repo: ${result.repo}`,
					result.posted ? `Posted to thread ✓ (ts ${result.replyTs})` : "NOT posted (user cancelled)",
					`Draft: ${basename(result.draftPath)}`,
				].join("\n");

				return {
					content: [{ type: "text", text: summary }],
					details: { status: "done", ...result },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Pipeline failed: ${err.message}` }],
					details: { status: "error", error: err.message },
				};
			}
		},

		renderCall(args: any, theme: any) {
			const url = (args as any).url || "";
			const preview = url.length > 60 ? "..." + url.slice(-57) : url;
			return new Text(
				theme.fg("toolTitle", theme.bold("run_slack_reply ")) + theme.fg("muted", preview),
				0, 0,
			);
		},

		renderResult(result: any, options: any, theme: any) {
			const details = result.details as any;

			if (options.isPartial || details?.status === "running") {
				return new Text(theme.fg("accent", "● slack-reply running..."), 0, 0);
			}
			if (details?.status === "error") {
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			}
			const flag = details?.posted ? "posted" : "draft only";
			return new Text(
				theme.fg("success", `✓ #${details?.channelName} → ${details?.repo} (${flag})`),
				0, 0,
			);
		},
	});

	// ── Command: /slack-reply ─────────────────────────────────────────────────

	pi.registerCommand("slack-reply", {
		description: "Reply to a Slack message grounded in its project repo: /slack-reply <url>",
		handler: async (args: string | undefined, ctx: any) => {
			widgetCtx = ctx;
			const url = args?.trim();
			if (!url) {
				ctx.ui.notify("Usage: /slack-reply <slack-message-url>", "error");
				return;
			}

			try {
				const result = await runPipeline(url, ctx.cwd, ctx);
				ctx.ui.notify(
					result.posted
						? `✓ Reply posted to #${result.channelName} (repo: ${result.repo})`
						: `Draft saved (not posted): ${basename(result.draftPath)}`,
					"success",
				);
			} catch (err: any) {
				ctx.ui.notify(`Pipeline failed: ${err.message}`, "error");
			}
		},
	});

	// ── before_agent_start: APPEND to existing system prompt ─────────────────

	pi.on("before_agent_start", async (event: any) => {
		return {
			systemPrompt: event.systemPrompt + `

## Slack Reply Tool

You have access to \`run_slack_reply\` — a pipeline that reads a Slack message URL, finds the related GitHub project repo, analyzes the codebase, and drafts a grounded reply.

**Use run_slack_reply immediately when:**
- The user pastes a Slack message URL (https://<workspace>.slack.com/archives/...)
- The user asks to "reply to" or "answer" a Slack message/thread

**Do NOT fetch or analyze anything yourself.** The pipeline handles Slack access, repo resolution, codebase analysis, and drafting. It will pause to ask the user to approve/edit the draft before posting — this is expected behavior, not an error.

After it completes, summarize: channel, repo, whether the reply was posted, and the draft file name.`,
		};
	});

	// ── session_start ──────────────────────────────────────────────────────────

	pi.on("session_start", async (_event: any, ctx: any) => {
		if (widgetCtx) {
			widgetCtx.ui.setWidget("slack-reply", undefined);
		}
		widgetCtx = ctx;
		resetSteps();

		ctx.ui.setStatus("slack-reply", "ready");
		ctx.ui.notify("Slack Reply ready — paste a Slack message URL or use /slack-reply <url>", "info");
	});
}
