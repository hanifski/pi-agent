/**
 * Morning Coffee ☕ — Start your day with a friendly task summary!
 *
 * Fetches today's emails via Composio Gmail integration and extracts
 * actionable tasks with priorities. Output in friendly Bahasa Indonesia.
 *
 * Pipeline: Connection Check → Email Fetch → Task Analyst Agent → Markdown Output
 *
 * Usage: pi -e ~/agency-tools/extensions/morning-coffee.ts
 * Or:    /morning-coffee           (default email)
 *        /morning-coffee work@...  (switch account)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import * as os from "os";
import {
  type GmailConnection,
  type EmailMessage,
  type DigestResult,
  listGmailConnections,
  initiateGmailConnection,
  waitForConnection,
  fetchTodayEmails,
  parseTaskJson,
  formatDigestMarkdown,
  serializeEmailsForAgent,
  getUserId,
} from "./morning-coffee-lib.ts";

// ── Types ──────────────────────────────────────────────────────────────────────

/** Tracks progress of a single pipeline step for widget rendering */
interface StepState {
  label: string;
  status: "idle" | "running" | "done" | "error";
  elapsed: number; // milliseconds since step started
  lastWork: string; // latest progress message
}

// ── Pipeline Steps ──────────────────────────────────────────────────────────────

const PIPELINE_STEPS: StepState[] = [
  { label: "Koneksi Gmail", status: "idle", elapsed: 0, lastWork: "" },
  { label: "Ambil Email", status: "idle", elapsed: 0, lastWork: "" },
  { label: "Analisis Task", status: "idle", elapsed: 0, lastWork: "" },
];

// ── Agent Runner ───────────────────────────────────────────────────────────────

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

/** Load agent definition with frontmatter parsing from local/bundled/global locations */
function loadAgentDef(
  agentName: string,
  cwd: string,
): { systemPrompt: string; model: string } {
  const candidates = [
    join(cwd, "agents", `${agentName}.md`),                          // project-local override
    join(EXTENSION_DIR, "agents", `${agentName}.md`),                // bundled with the extension
    join(os.homedir(), ".pi", "agent", "agents", `${agentName}.md`), // global fallback
  ];

  const agentFile = candidates.find(existsSync);
  if (!agentFile) {
    throw new Error(
      `Agent "${agentName}" gak ketemu. Cari di:\n  ${candidates.join("\n  ")}`,
    );
  }

  const raw = readFileSync(agentFile, "utf-8");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`Format frontmatter gak valid di ${agentFile}`);

  // Parse frontmatter key:value pairs
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0)
      frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  return {
    systemPrompt: match[2].trim(),
    model: frontmatter.model || "openrouter/google/gemini-3-flash-preview",
  };
}

/**
 * Spawn a Pi agent subprocess and stream output.
 * Parses JSON event stream for text deltas and invokes onChunk callback.
 */
function spawnPiAgent(
  agentName: string,
  prompt: string,
  cwd: string,
  ctx: any,
  onChunk?: (text: string) => void,
): Promise<string> {
  const def = loadAgentDef(agentName, cwd);
  const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : def.model;

  return new Promise((resolve, reject) => {
    const proc = spawn(
      "pi",
      [
        "--mode",
        "json",
        "-p",
        "--no-extensions",
        "--model",
        model,
        "--tools",
        "",
        "--thinking",
        "off",
        "--append-system-prompt",
        def.systemPrompt,
        prompt,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      },
    );

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
              if (onChunk) onChunk(text);
            }
          }
        } catch {}
      }
    });

    proc.stderr!.setEncoding("utf-8");
    proc.stderr!.on("data", () => {}); // discard stderr

    proc.on("close", (code: number | null) => {
      // Process any remaining buffered content
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent?.type === "text_delta"
          ) {
            textChunks.push(event.assistantMessageEvent.delta || "");
          }
        } catch {}
      }
      if (code === 0) resolve(textChunks.join(""));
      else reject(new Error(`Agent "${agentName}" exit code ${code}`));
    });

    proc.on("error", (err: Error) => reject(err));
  });
}

// ── Widget ─────────────────────────────────────────────────────────────────────

/** Global state for progress widget */
let stepStates: StepState[] = PIPELINE_STEPS.map((s) => ({ ...s }));
let widgetCtx: any = null;

/** Reset all steps to initial state */
function resetSteps() {
  stepStates = PIPELINE_STEPS.map((s) => ({ ...s }));
}

/** Render a bordered card for a single pipeline step */
function renderCard(state: StepState, colWidth: number, theme: any): string[] {
  const w = colWidth - 2;
  const truncate = (s: string, max: number) =>
    s.length > max ? s.slice(0, max - 3) + "..." : s;

  // Map status to theme colors and icons
  const statusColor =
    state.status === "idle"
      ? "dim"
      : state.status === "running"
        ? "accent"
        : state.status === "done"
          ? "success"
          : "error";

  const statusIcon =
    state.status === "idle"
      ? "○"
      : state.status === "running"
        ? "●"
        : state.status === "done"
          ? "✓"
          : "✗";

  const nameStr = theme.fg("accent", theme.bold(truncate(state.label, w)));
  const nameVis = Math.min(state.label.length, w);

  const timeStr =
    state.status !== "idle" ? ` ${Math.round(state.elapsed / 1000)}s` : "";
  const statusStr = `${statusIcon} ${state.status}${timeStr}`;
  const statusLine = theme.fg(statusColor, statusStr);
  const statusVis = statusStr.length;

  const workRaw = state.lastWork || "";
  const workText = workRaw ? truncate(workRaw, Math.min(50, w - 1)) : "";
  const workLine = workText
    ? theme.fg("muted", workText)
    : theme.fg("dim", "—");
  const workVis = workText ? workText.length : 1;

  const border = (content: string, visLen: number) =>
    theme.fg("dim", "│") +
    content +
    " ".repeat(Math.max(0, w - visLen)) +
    theme.fg("dim", "│");

  return [
    theme.fg("dim", "┌" + "─".repeat(w) + "┐"),
    border(" " + nameStr, 1 + nameVis),
    border(" " + statusLine, 1 + statusVis),
    border(" " + workLine, 1 + workVis),
    theme.fg("dim", "└" + "─".repeat(w) + "┘"),
  ];
}

/** Update the TUI widget with current pipeline state */
function updateWidget() {
  if (!widgetCtx) return;

  widgetCtx.ui.setWidget("morning-coffee", (_tui: any, theme: any) => {
    const text = new Text("", 0, 1);

    return {
      render(width: number): string[] {
        const arrowWidth = 5;
        const cols = stepStates.length;
        const colWidth = Math.max(
          16,
          Math.floor((width - arrowWidth * (cols - 1)) / cols),
        );
        const arrowRow = 2; // which row gets the arrow between cards

        const cards = stepStates.map((s) => renderCard(s, colWidth, theme));
        const cardHeight = cards[0].length;
        const outputLines: string[] = [];

        outputLines.push(theme.fg("accent", theme.bold(" ☕ Morning Coffee")));
        outputLines.push("");

        // Stitch cards horizontally with arrows
        for (let line = 0; line < cardHeight; line++) {
          let row = cards[0][line];
          for (let c = 1; c < cols; c++) {
            row +=
              line === arrowRow
                ? theme.fg("dim", " ──▶ ")
                : " ".repeat(arrowWidth);
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

// ── Step Runner ────────────────────────────────────────────────────────────────

/**
 * Generic step executor with progress tracking.
 * Updates widget state and handles timing/errors automatically.
 */
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

// ── Connection Management with User Interaction ────────────────────────────────

/** Extract human-readable label from a Gmail connection */
function connectionLabel(c: GmailConnection): string {
  return c.integration?.name || c.toolkit?.name || "Gmail";
}

/**
 * Ensure a valid Gmail connection exists, creating one if needed.
 * Handles multiple connections by preferring email match or prompting user.
 */
async function ensureGmailConnection(
  preferredEmail: string | undefined,
  userId: string,
  ctx: any,
): Promise<{ connection: GmailConnection; isNew: boolean }> {
  const connections = await listGmailConnections(userId);

  const activeConnections = connections.filter((c) => c.status === "ACTIVE");

  if (activeConnections.length === 0) {
    // No active connection — initiate OAuth flow
    if (!ctx.hasUI) {
      throw new Error(
        "Belum ada koneksi Gmail. Jalankan di mode interaktif untuk setup koneksi.",
      );
    }

    stepStates[0].lastWork = "Belum ada koneksi, setup baru...";
    updateWidget();

    const result = await initiateGmailConnection(userId);

    ctx.ui.notify(
      `🔗 Buka link ini untuk connect Gmail:\n${result.redirectUrl}`,
      "info",
    );

    stepStates[0].lastWork = "Menunggu authorization...";
    updateWidget();

    const connection = await waitForConnection(result.connectedAccountId);
    if (!connection) {
      throw new Error("Timeout menunggu authorization Gmail. Coba lagi ya.");
    }

    return { connection, isNew: true };
  }

  if (activeConnections.length === 1) {
    return { connection: activeConnections[0], isNew: false };
  }

  // Multiple connections — try to match preferred email
  if (preferredEmail) {
    const match = activeConnections.find((c) =>
      connectionLabel(c).toLowerCase().includes(preferredEmail.toLowerCase()),
    );
    if (match) return { connection: match, isNew: false };
  }

  // Non-interactive mode: use first connection
  if (!ctx.hasUI) {
    return { connection: activeConnections[0], isNew: false };
  }

  // Interactive: prompt user to select
  const labels = activeConnections.map(connectionLabel);
  const selected = await ctx.ui.select("Pilih akun Gmail:", labels);
  const selectedIdx = Math.max(
    0,
    labels.findIndex((l) => l === selected),
  );
  return { connection: activeConnections[selectedIdx], isNew: false };
}

// ── Core Pipeline ──────────────────────────────────────────────────────────────

interface PipelineResult {
  digestPath: string;
  emailCount: number;
  taskCount: number;
  markdown: string;
}

/** Save digest markdown to a dated file in cwd */
function saveDigest(markdown: string, cwd: string): string {
  const slug = new Date().toISOString().split("T")[0];
  const digestPath = join(cwd, `morning-coffee-${slug}.md`);
  writeFileSync(digestPath, markdown, "utf-8");
  return digestPath;
}

/**
 * Execute the full morning coffee pipeline:
 * 1. Connect to Gmail (or initiate OAuth)
 * 2. Fetch today's emails
 * 3. Analyze with agent and extract tasks
 * 4. Save digest markdown
 */
async function runPipeline(
  preferredEmail: string | undefined,
  cwd: string,
  ctx: any,
): Promise<PipelineResult> {
  resetSteps();
  updateWidget();

  // Step 1 — Ensure Gmail Connection
  const userId = getUserId();
  const { connection } = await runStep(
    0,
    () => ensureGmailConnection(preferredEmail, userId, ctx),
    (r) =>
      r.isNew
        ? `Koneksi baru: ${connectionLabel(r.connection)}`
        : `Terhubung: ${connectionLabel(r.connection)}`,
  );

  // Step 2 — Fetch Today's Emails
  const emails = await runStep(
    1,
    () => fetchTodayEmails(connection.id, userId),
    (r) => `${r.length} email hari ini`,
  );

  // Early exit if no emails
  if (emails.length === 0) {
    const digest: DigestResult = {
      date: new Date().toISOString().split("T")[0],
      emailCount: 0,
      taskCount: 0,
      greeting: "Selamat pagi! Inbox kamu kosong hari ini, mantap! 🎉",
      highPriority: [],
      mediumPriority: [],
      lowPriority: [],
      closing: "Waktunya fokus ke hal lain yang penting!",
    };
    const markdown = formatDigestMarkdown(digest);
    return { digestPath: "", emailCount: 0, taskCount: 0, markdown };
  }

  // Step 3 — Analyze with Agent (with auto-retry on invalid JSON)
  const emailData = serializeEmailsForAgent(emails);
  const prompt = `Analisis email-email ini dan extract task yang actionable:\n\n${emailData}`;

  // Stream agent output to widget progress display
  const onChunk = (chunk: string) => {
    const state = stepStates[2];
    const accumulated = state.lastWork + chunk;
    state.lastWork =
      accumulated
        .split("\n")
        .filter((l) => l.trim())
        .pop() || "";
    updateWidget();
  };

  const digest = await runStep(
    2,
    async () => {
      let output = await spawnPiAgent(
        "email-task-analyst",
        prompt,
        cwd,
        ctx,
        onChunk,
      );
      try {
        return parseTaskJson(output);
      } catch (err: any) {
        // Auto-retry once with corrective prompt if JSON parsing fails
        stepStates[2].lastWork = "retrying (bad format)...";
        updateWidget();
        output = await spawnPiAgent(
          "email-task-analyst",
          `${prompt}\n\n<format-violation>Output kamu sebelumnya invalid: ${err.message}\nJANGAN nanya. JANGAN jelasin. Output HANYA JSON object yang diminta, mulai sekarang.</format-violation>`,
          cwd,
          ctx,
          onChunk,
        );
        return parseTaskJson(output);
      }
    },
    (d) => `${d.taskCount} task ditemukan`,
  );

  // Fix email count (model sometimes miscounts)
  digest.emailCount = emails.length;

  const markdown = formatDigestMarkdown(digest);
  const digestPath = saveDigest(markdown, cwd);

  return {
    digestPath,
    emailCount: digest.emailCount,
    taskCount: digest.taskCount,
    markdown,
  };
}

// ── Extension ──────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Tool: run_morning_coffee ──────────────────────────────────────────────

  pi.registerTool({
    name: "run_morning_coffee",
    label: "Morning Coffee ☕",
    description:
      "Ambil email hari ini dari Gmail dan extract task yang actionable. Output dalam Bahasa Indonesia yang friendly. Bisa specify email untuk switch akun.",

    parameters: Type.Object({
      email: Type.Optional(
        Type.String({
          description: "Email akun Gmail yang mau dipakai (opsional)",
        }),
      ),
    }),

    async execute(
      _toolCallId: string,
      params: any,
      _signal: any,
      onUpdate: any,
      ctx: any,
    ) {
      widgetCtx = ctx;
      const { email } = params as { email?: string };

      if (onUpdate) {
        onUpdate({
          content: [{ type: "text", text: "Mulai bikin morning coffee..." }],
          details: { status: "running" },
        });
      }

      try {
        const result = await runPipeline(email, ctx.cwd, ctx);

        return {
          content: [{ type: "text", text: result.markdown }],
          details: {
            status: "done",
            emailCount: result.emailCount,
            taskCount: result.taskCount,
            digestPath: result.digestPath,
          },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Gagal baca email: ${err.message}` }],
          details: { status: "error", error: err.message },
        };
      }
    },

    renderCall(args: any, theme: any) {
      const email = (args as any).email;
      const preview = email ? ` (${email})` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("run_morning_coffee")) +
          theme.fg("muted", preview),
        0,
        0,
      );
    },

    renderResult(result: any, options: any, theme: any) {
      const details = result.details as any;

      if (options.isPartial || details?.status === "running") {
        return new Text(theme.fg("accent", "● Bikin morning coffee..."), 0, 0);
      }

      if (details?.status === "error") {
        return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
      }

      const pathSuffix = details?.digestPath
        ? ` → ${basename(details.digestPath)}`
        : "";
      return new Text(
        theme.fg(
          "success",
          `✓ ${details?.taskCount} task dari ${details?.emailCount} email${pathSuffix}`,
        ),
        0,
        0,
      );
    },
  });

  // ── Command: /morning-coffee ──────────────────────────────────────────────

  pi.registerCommand("morning-coffee", {
    description:
      "Baca email pagi dan extract task. Usage: /morning-coffee [email]",
    handler: async (args: string | undefined, ctx: any) => {
      widgetCtx = ctx;
      const email = args?.trim() || undefined;

      try {
        const result = await runPipeline(email, ctx.cwd, ctx);
        const pathNote = result.digestPath
          ? `\n→ ${basename(result.digestPath)}`
          : "";
        ctx.ui.notify(
          `✓ Selesai! ${result.taskCount} task dari ${result.emailCount} email${pathNote}`,
          "success",
        );
      } catch (err: any) {
        ctx.ui.notify(`Gagal: ${err.message}`, "error");
      }
    },
  });

  // ── before_agent_start: Auto-trigger suggestions ───────────────────────────

  pi.on("before_agent_start", async (event: any) => {
    return {
      systemPrompt:
        event.systemPrompt +
        `

## Morning Coffee Tool
Kamu punya akses ke \`run_morning_coffee\` — pipeline untuk baca email hari ini dari Gmail.

**Gunakan run_morning_coffee ketika:**
- User minta "baca email pagi", "morning coffee", atau "apakah ada email penting hari ini"
- User mau tau "apa yang harus dilakukan hari ini"
- User mention "inbox" atau "gmail"

Pipeline akan:
1. Cek koneksi Gmail (kalau belum ada, kasih link OAuth)
2. Ambil email hari ini
3. Extract task dengan prioritas (wajib hari ini, minggu ini, santai)

Output dalam Bahasa Indonesia yang friendly dan casual.
`,
    };
  });

  // ── session_start ──────────────────────────────────────────────────────────

  pi.on("session_start", async (_event: any, ctx: any) => {
    // Clear stale widget from a previous session context (pattern from agent-team.ts)
    if (widgetCtx) {
      widgetCtx.ui.setWidget("morning-coffee", undefined);
    }
    widgetCtx = ctx;
    resetSteps();
    updateWidget();

    ctx.ui.setStatus("morning-coffee", "ready");
  });
}
