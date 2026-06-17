/**
 * Breakdown — Client intake document → task list pipeline
 *
 * Reads any client intake document (PRD, meeting notes, spreadsheet, etc.)
 * and outputs three markdown files:
 *   1. client-recommendations-<project>.md — gap analysis & questions for client
 *   2. task-breakdown-<project>.md        — full task list in [Division - UserType] format
 *   3. user-flows-<project>.md            — backbone artifact for PoC/prototype/UAT
 *
 * Pipeline: Classifier → Flow Analyst → [PM Interview] → Feature Extractor
 *           → Task Generator (parallel) → Consolidator (infra dedup)
 *
 * The main agent can trigger this automatically when the user drops a file or
 * asks to break down a document — via the registered `run_breakdown` tool.
 *
 * Usage: pi -e ~/agency-tools/extensions/breakdown.ts
 * Or:    /breakdown <filepath>  (manual override)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname, basename } from "path";
import * as os from "os";
import { fileURLToPath } from "url";
import { applyExtensionDefaults } from "./themeMap.ts";
import {
	type Feature,
	type PmAnswer,
	slugify,
	parseAgent3Json,
	salvageAgent3Json,
	extractClientRecommendations,
	parseGaps,
	parseGapOptions,
	buildTaskBreakdown,
	buildUserFlowsDoc,
	appendPmAnswers,
	formatPmAnswersBlock,
	sumStoryPoints,
	extractDocumentText,
} from "./breakdown-lib.ts";

// ── Types ──────────────────────────────────────────────────────────────────────

interface AgentDef {
	systemPrompt: string;
	tools: string;
}

type StepStatus = "idle" | "running" | "done" | "error";

interface StepState {
	label: string;
	status: StepStatus;
	elapsed: number;
	lastWork: string;
}

// ── Pipeline Step Definitions ──────────────────────────────────────────────────

const PIPELINE_STEPS: StepState[] = [
	{ label: "Classifier",        status: "idle", elapsed: 0, lastWork: "" },
	{ label: "Flow Analyst",      status: "idle", elapsed: 0, lastWork: "" },
	{ label: "Feature Extractor", status: "idle", elapsed: 0, lastWork: "" },
	{ label: "Task Generator",    status: "idle", elapsed: 0, lastWork: "" },
	{ label: "Consolidator",      status: "idle", elapsed: 0, lastWork: "" },
];

// ── Agent Runner ───────────────────────────────────────────────────────────────

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

function loadAgentDef(agentName: string, cwd: string): AgentDef {
	const candidates = [
		join(cwd, "agents", `${agentName}.md`),                        // project-local override
		join(EXTENSION_DIR, "agents", `${agentName}.md`),              // bundled with the extension
		join(os.homedir(), ".pi", "agent", "agents", `${agentName}.md`), // global fallback
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
		tools: frontmatter.tools?.trim() || "read",
	};
}

function spawnPiAgent(
	agentName: string,
	prompt: string,
	cwd: string,
	ctx: any,
	onChunk?: (text: string) => void,
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
							if (onChunk) onChunk(text);
						}
					}
				} catch {}
			}
		});

		proc.stderr!.setEncoding("utf-8");
		proc.stderr!.on("data", () => {});

		proc.on("close", (code) => {
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

		proc.on("error", (err) => reject(err));
	});
}

// ── Widget ─────────────────────────────────────────────────────────────────────

let stepStates: StepState[] = PIPELINE_STEPS.map(s => ({ ...s }));
let widgetCtx: any = null;
let projectLabel = "";

function resetSteps() {
	stepStates = PIPELINE_STEPS.map(s => ({ ...s }));
	projectLabel = "";
}

function renderCard(state: StepState, colWidth: number, theme: any): string[] {
	const w = colWidth - 2;
	const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max - 3) + "..." : s;

	const statusColor = state.status === "idle"    ? "dim"
		: state.status === "running" ? "accent"
		: state.status === "done"    ? "success"
		: "error";

	const statusIcon = state.status === "idle"    ? "○"
		: state.status === "running" ? "●"
		: state.status === "done"    ? "✓"
		: "✗";

	const nameStr  = theme.fg("accent", theme.bold(truncate(state.label, w)));
	const nameVis  = Math.min(state.label.length, w);

	const timeStr   = state.status !== "idle" ? ` ${Math.round(state.elapsed / 1000)}s` : "";
	const statusStr = `${statusIcon} ${state.status}${timeStr}`;
	const statusLine = theme.fg(statusColor, statusStr);
	const statusVis  = statusStr.length;

	const workRaw  = state.lastWork || "";
	const workText = workRaw ? truncate(workRaw, Math.min(50, w - 1)) : "";
	const workLine = workText ? theme.fg("muted", workText) : theme.fg("dim", "—");
	const workVis  = workText ? workText.length : 1;

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

	widgetCtx.ui.setWidget("breakdown", (_tui: any, theme: any) => {
		const text = new Text("", 0, 1);

		return {
			render(width: number): string[] {
				const arrowWidth = 5;
				const cols = stepStates.length;
				const colWidth = Math.max(14, Math.floor((width - arrowWidth * (cols - 1)) / cols));
				const arrowRow = 2;

				const cards = stepStates.map(s => renderCard(s, colWidth, theme));
				const cardHeight = cards[0].length;
				const outputLines: string[] = [];

				if (projectLabel) {
					outputLines.push(theme.fg("accent", theme.bold(` ${projectLabel}`)));
				}

				for (let line = 0; line < cardHeight; line++) {
					let row = cards[0][line];
					for (let c = 1; c < cols; c++) {
						row += line === arrowRow
							? theme.fg("dim", " ──▶ ")
							: " ".repeat(arrowWidth);
						row += cards[c][line];
					}
					outputLines.push(row);
				}

				text.setText(outputLines.join("\n"));
				return text.render(width);
			},
			invalidate() { text.invalidate(); },
		};
	});
}

// ── Step Runner ────────────────────────────────────────────────────────────────

async function runStep(
	stepIndex: number,
	agentName: string,
	prompt: string,
	cwd: string,
	ctx: any,
	validate?: (output: string) => string | null, // returns error message, or null if valid
): Promise<string> {
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

	const onChunk = (chunk: string) => {
		const accumulated = state.lastWork + chunk;
		state.lastWork = accumulated.split("\n").filter((l: string) => l.trim()).pop() || "";
		updateWidget();
	};

	try {
		let output = await spawnPiAgent(agentName, prompt, cwd, ctx, onChunk);

		// Validate output format — retry ONCE with a corrective prompt if invalid.
		// Small models sometimes ask questions instead of following the format.
		if (validate) {
			const problem = validate(output);
			if (problem) {
				state.lastWork = "retrying (bad format)...";
				updateWidget();
				output = await spawnPiAgent(
					agentName,
					`${prompt}\n\n<format-violation>Your previous response was invalid: ${problem}\nDo NOT ask questions. Do NOT explain. Output ONLY the required format, starting now.</format-violation>`,
					cwd, ctx, onChunk
				);
				const stillBad = validate(output);
				if (stillBad) throw new Error(`${state.label}: ${stillBad}`);
			}
		}

		state.status = "done";
		state.elapsed = Date.now() - start;
		state.lastWork = output.split("\n").filter((l: string) => l.trim()).pop() || "";
		updateWidget();
		return output;
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

// ── Concurrency-limited map ────────────────────────────────────────────────────
// Fan-out spawns one pi subprocess per feature — cap how many run at once.

const FANOUT_CONCURRENCY = 6;

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
	const results: PromiseSettledResult<R>[] = new Array(items.length);
	let next = 0;

	async function worker() {
		while (next < items.length) {
			const i = next++;
			try {
				results[i] = { status: "fulfilled", value: await fn(items[i], i) };
			} catch (reason) {
				results[i] = { status: "rejected", reason };
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

// ── PM Interview ───────────────────────────────────────────────────────────────
// After the Flow Analyst finds gaps, ask the PM which ones they can answer
// right now. Answers become authoritative context for downstream agents;
// the rest stay in the client recommendations file.

const MAX_INTERVIEW_GAPS = 12;
const MAX_OPTIONS_PER_GAP = 3;

const TYPE_OWN = "✏️  Type my own answer";
const DEFER    = "Defer to client";
const SKIP     = "Skip remaining gaps";

/** One LLM call proposing answer options for all gaps at once. */
async function suggestGapOptions(
	gaps: string[],
	agent2Output: string,
	cwd: string,
	ctx: any,
): Promise<string[][]> {
	const gapList = gaps.map((g, i) => `${i + 1}. ${g}`).join("\n");
	const prompt = `Project analysis:\n\n${agent2Output}\n\n---GAPS---\nPropose answer options for each of these ${gaps.length} gaps:\n${gapList}`;

	let raw = await spawnPiAgent("breakdown-gap-suggester", prompt, cwd, ctx);
	try {
		return parseGapOptions(raw, gaps.length);
	} catch (firstErr) {
		// One corrective retry, same pattern as runStep
		raw = await spawnPiAgent(
			"breakdown-gap-suggester",
			`${prompt}\n\n<format-violation>Your previous response was invalid: ${(firstErr as Error).message}\nDo NOT ask questions. Output ONLY the required JSON, starting now.</format-violation>`,
			cwd, ctx
		);
		return parseGapOptions(raw, gaps.length);
	}
}

async function interviewPm(gaps: string[], suggestions: string[][], ctx: any): Promise<PmAnswer[]> {
	const answers: PmAnswer[] = [];
	if (gaps.length === 0 || !ctx.hasUI) return answers;

	const start = await ctx.ui.select(
		`Flow Analyst found ${gaps.length} gaps. Interview now?`,
		["Interview me now", "Defer all to client"],
	);
	if (start !== "Interview me now") return answers;

	const capped = gaps.slice(0, MAX_INTERVIEW_GAPS);
	for (let i = 0; i < capped.length; i++) {
		const gap = capped[i];
		const options = (suggestions[i] || []).slice(0, MAX_OPTIONS_PER_GAP);
		const choices = [...options, TYPE_OWN, DEFER, SKIP];

		const action = await ctx.ui.select(`Gap ${i + 1}/${capped.length}: ${gap}`, choices);

		if (action === undefined || action === SKIP) break;
		if (action === DEFER) continue;

		if (action === TYPE_OWN) {
			const answer = await ctx.ui.input(`Answer for: ${gap}`, "");
			if (answer && answer.trim()) {
				answers.push({ gap, answer: answer.trim() });
			}
		} else {
			// PM picked one of the LLM-suggested options
			answers.push({ gap, answer: action });
		}
	}

	return answers;
}

// ── Stage Logging ──────────────────────────────────────────────────────────────
// Raw agent outputs go to disk so a failed stage is never a black box.

function makeRunLogger(cwd: string) {
	const dir = join(cwd, ".pi", "breakdown-logs", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
	try { mkdirSync(dir, { recursive: true }); } catch {}
	return {
		dir,
		log(name: string, content: string) {
			try { writeFileSync(join(dir, name), content, "utf-8"); } catch {}
		},
	};
}

// ── Core Pipeline ──────────────────────────────────────────────────────────────

interface PipelineResult {
	projectName: string;
	recPath: string;
	breakdownPath: string;
	flowsPath: string;
	featureCount: number;
	moduleCount: number;
	totalStoryPoints: number;
	pmAnswerCount: number;
}

async function runPipeline(resolvedPath: string, cwd: string, ctx: any): Promise<PipelineResult> {
	const logger = makeRunLogger(cwd);
	try {
		return await runPipelineInner(resolvedPath, cwd, ctx, logger);
	} catch (err: any) {
		throw new Error(`${err.message}\n(stage logs: ${logger.dir})`);
	}
}

async function runPipelineInner(
	resolvedPath: string,
	cwd: string,
	ctx: any,
	logger: ReturnType<typeof makeRunLogger>,
): Promise<PipelineResult> {
	const outputDir = dirname(resolvedPath);

	resetSteps();
	updateWidget();

	// Step 0 — Deterministic extraction in code. The LLM never touches the raw file.
	const documentText = extractDocumentText(resolvedPath);

	// Step 1 — Normalize & extract project name (content passed inline)
	const agent1Output = await runStep(
		0, "breakdown-classifier",
		`Normalize this document (filename: ${basename(resolvedPath)}):\n\n${documentText}`,
		cwd, ctx,
		(out) => /^PROJECT_NAME:\s*.+$/m.test(out)
			? null
			: "Output must start with a PROJECT_NAME: line followed by the normalized content.",
	);

	logger.log("1-classifier.md", agent1Output);

	const projectNameMatch = agent1Output.match(/^PROJECT_NAME:\s*(.+)$/m);
	const projectName = projectNameMatch ? projectNameMatch[1].trim() : "Unknown Project";
	projectLabel = projectName;
	updateWidget();

	// Step 2 — User Flow Analysis
	const agent2Output = await runStep(
		1, "breakdown-flow-analyst",
		`Analyze this project document:\n\n${agent1Output}`,
		cwd, ctx,
		(out) => out.includes("---CLIENT_RECOMMENDATIONS_START---")
			? null
			: "Output must contain the ---CLIENT_RECOMMENDATIONS_START--- ... ---CLIENT_RECOMMENDATIONS_END--- block.",
	);

	logger.log("2-flow-analyst.md", agent2Output);

	const clientRecommendations = extractClientRecommendations(agent2Output);

	// PM Interview — gaps the PM can answer now don't need to wait for the client.
	// The LLM proposes answer options first so the PM mostly just picks one.
	const gaps = parseGaps(agent2Output);
	let suggestions: string[][] = [];
	if (gaps.length > 0 && ctx.hasUI) {
		stepStates[1].lastWork = `${gaps.length} gaps — generating answer options...`;
		updateWidget();
		try {
			suggestions = await suggestGapOptions(gaps, agent2Output, cwd, ctx);
		} catch (err: any) {
			// Degrade to type-your-own, but say so — silent fallback hides real bugs
			suggestions = [];
			ctx.ui.notify(`Answer options unavailable (${err.message}) — falling back to manual answers`, "warning");
		}
	}
	stepStates[1].lastWork = gaps.length > 0 ? `${gaps.length} gaps — interviewing PM...` : "no gaps";
	updateWidget();
	const pmAnswers = await interviewPm(gaps, suggestions, ctx);
	stepStates[1].lastWork = pmAnswers.length > 0
		? `${pmAnswers.length}/${gaps.length} gaps resolved by PM`
		: `${gaps.length} gaps deferred to client`;
	updateWidget();

	const pmBlock = formatPmAnswersBlock(pmAnswers);

	// Step 3 — Feature Extraction (PM answers are authoritative context)
	const agent3Output = await runStep(
		2, "breakdown-feature-extractor",
		`Extract features from this analyzed document:\n\n${agent1Output}\n\n---ANALYSIS---\n${agent2Output}${pmBlock}`,
		cwd, ctx,
		(out) => {
			try { parseAgent3Json(out); return null; } catch {}
			// Truncated output: complete feature objects are still salvageable
			if (salvageAgent3Json(out)) return null;
			return `Output must be ONLY a \`\`\`json block with projectName and features array. Your output began with: "${out.slice(0, 150)}"`;
		},
	);

	logger.log("3-feature-extractor.md", agent3Output);

	let agent3Parsed: { projectName: string; features: Feature[] };
	try {
		agent3Parsed = parseAgent3Json(agent3Output);
	} catch {
		const salvaged = salvageAgent3Json(agent3Output);
		if (!salvaged) throw new Error(`Feature Extractor output unusable — see 3-feature-extractor.md in logs`);
		agent3Parsed = salvaged;
		stepStates[2].lastWork = `salvaged ${salvaged.features.length} features (output truncated)`;
		updateWidget();
	}
	const { projectName: parsedName, features } = agent3Parsed;
	const finalProjectName = parsedName || projectName;
	projectLabel = finalProjectName;

	// Step 4 — Task Generation (parallel per feature)
	let doneCount = 0;
	stepStates[3].status = "running";
	stepStates[3].elapsed = 0;
	stepStates[3].lastWork = `0/${features.length} features`;
	const step4Start = Date.now();
	updateWidget();

	const step4Timer = setInterval(() => {
		stepStates[3].elapsed = Date.now() - step4Start;
		updateWidget();
	}, 1000);

	// allSettled semantics: one failed feature degrades to a visible placeholder
	// instead of killing the whole run.
	let agent4Results: Array<{ feature: Feature; markdown: string }>;
	let failedCount = 0;
	try {
		const settled = await mapWithConcurrency(features, FANOUT_CONCURRENCY, async (feature) => {
			const featureJson = JSON.stringify(feature, null, 2);
			const prompt = `Generate division tasks for this feature:\n\`\`\`json\n${featureJson}\n\`\`\`${pmBlock}`;
			const markdown = await spawnPiAgent("breakdown-task-generator", prompt, cwd, ctx);
			doneCount++;
			stepStates[3].lastWork = `${doneCount}/${features.length} features`;
			stepStates[3].elapsed = Date.now() - step4Start;
			updateWidget();
			return { feature, markdown: markdown.trim() };
		});

		agent4Results = settled.map((result, i) => {
			if (result.status === "fulfilled") return result.value;
			failedCount++;
			const feature = features[i];
			return {
				feature,
				markdown: `### ${feature.name}\n**[GENERATION FAILED:** ${(result.reason as Error)?.message || "unknown error"}**]**\nRe-run /breakdown or write this feature's tasks manually.`,
			};
		});

		stepStates[3].status = failedCount === features.length ? "error" : "done";
		stepStates[3].elapsed = Date.now() - step4Start;
		stepStates[3].lastWork = failedCount > 0
			? `${features.length - failedCount}/${features.length} ok, ${failedCount} failed`
			: `${features.length} features done`;
		if (failedCount === features.length) {
			throw new Error("All feature task generations failed");
		}
	} finally {
		clearInterval(step4Timer);
		updateWidget();
	}

	// Step 5 — Consolidation. Parallel generation means each Task Generator
	// instance is blind to the others — infrastructure tasks overlap (CI/CD
	// appearing 3x). Merge them through one consolidator pass.
	const infraItems  = agent4Results.filter(r => r.feature.isInfrastructure);
	const normalItems = agent4Results.filter(r => !r.feature.isInfrastructure);

	let finalResults = agent4Results;
	if (infraItems.length > 1) {
		const consolidatedMd = await runStep(
			4, "breakdown-consolidator",
			`Consolidate these infrastructure task blocks. They were generated independently and overlap — merge duplicates so each concern (CI/CD, cloud setup, repo init, etc.) appears in exactly ONE task:\n\n${infraItems.map(i => i.markdown).join("\n\n")}`,
			cwd, ctx,
			(out) => out.includes("###") ? null : "Output must contain ### task blocks in the same markdown format.",
		);

		logger.log("5-consolidator.md", consolidatedMd);

		const infraModule = infraItems[0].feature.module || "Foundation";
		finalResults = [
			{ feature: { ...infraItems[0].feature, module: infraModule }, markdown: consolidatedMd.trim() },
			...normalItems,
		];
		stepStates[4].lastWork = `${infraItems.length} infra blocks merged`;
		updateWidget();
	} else {
		stepStates[4].status = "done";
		stepStates[4].lastWork = "skipped — no overlap";
		updateWidget();
	}

	// Write output files
	const slug = slugify(finalProjectName);

	const recPath = join(outputDir, `client-recommendations-${slug}.md`);
	writeFileSync(recPath, appendPmAnswers(clientRecommendations, pmAnswers), "utf-8");

	const flowsPath = join(outputDir, `user-flows-${slug}.md`);
	writeFileSync(flowsPath, buildUserFlowsDoc(finalProjectName, agent2Output), "utf-8");

	const breakdownContent = buildTaskBreakdown(finalProjectName, finalResults);
	const breakdownPath = join(outputDir, `task-breakdown-${slug}.md`);
	writeFileSync(breakdownPath, breakdownContent, "utf-8");

	return {
		projectName: finalProjectName,
		recPath,
		breakdownPath,
		flowsPath,
		featureCount: features.length,
		moduleCount: new Set(features.map(f => f.module)).size,
		totalStoryPoints: sumStoryPoints(breakdownContent),
		pmAnswerCount: pmAnswers.length,
	};
}

// ── Extension ──────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

	// ── Tool: run_breakdown ────────────────────────────────────────────────────
	// The main agent calls this automatically when the user drops a file or
	// asks to break down a document.

	pi.registerTool({
		name: "run_breakdown",
		label: "Run Breakdown Pipeline",
		description: "Run the breakdown pipeline on a client intake document (PDF, DOCX, MD, TXT). May interview the PM about gaps. Outputs client-recommendations, task-breakdown, and user-flows markdown files in the same directory.",
		parameters: Type.Object({
			filepath: Type.String({ description: "Absolute or ~ path to the intake document" }),
		}),

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			widgetCtx = ctx;
			const { filepath } = params as { filepath: string };

			const resolvedPath = (filepath as string).startsWith("~")
				? join(os.homedir(), (filepath as string).slice(1))
				: filepath as string;

			if (!existsSync(resolvedPath)) {
				return {
					content: [{ type: "text", text: `File not found: ${resolvedPath}` }],
					details: { status: "error", error: "file_not_found" },
				};
			}

			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: `Starting breakdown pipeline: ${basename(resolvedPath)}` }],
					details: { status: "running", filepath: resolvedPath },
				});
			}

			try {
				const result = await runPipeline(resolvedPath, ctx.cwd, ctx);

				const summary = [
					`Project: ${result.projectName}`,
					`Features: ${result.featureCount} across ${result.moduleCount} modules`,
					`Total story points: ${result.totalStoryPoints}`,
					`Gaps resolved by PM during interview: ${result.pmAnswerCount}`,
					`→ ${basename(result.recPath)}`,
					`→ ${basename(result.breakdownPath)}`,
					`→ ${basename(result.flowsPath)}`,
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

		renderCall(args, theme) {
			const fp = (args as any).filepath || "";
			const preview = fp.length > 60 ? "..." + fp.slice(-57) : fp;
			return new Text(
				theme.fg("toolTitle", theme.bold("run_breakdown ")) +
				theme.fg("muted", preview),
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as any;

			if (options.isPartial || details?.status === "running") {
				return new Text(theme.fg("accent", "● breakdown running..."), 0, 0);
			}

			if (details?.status === "error") {
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			}

			const header = theme.fg("success", `✓ ${details?.projectName || "done"}`) +
				theme.fg("dim", ` — ${details?.featureCount} features, ${details?.moduleCount} modules, ${details?.totalStoryPoints} SP`);

			if (options.expanded && details?.recPath) {
				return new Text(
					header + "\n" +
					theme.fg("muted", `→ ${basename(details.recPath)}\n→ ${basename(details.breakdownPath)}\n→ ${basename(details.flowsPath)}`),
					0, 0,
				);
			}

			return new Text(header, 0, 0);
		},
	});

	// ── Command: /breakdown (manual override) ─────────────────────────────────

	pi.registerCommand("breakdown", {
		description: "Manually trigger the breakdown pipeline: /breakdown <filepath>",
		handler: async (args, ctx) => {
			widgetCtx = ctx;
			const filePath = args?.trim();
			if (!filePath) {
				ctx.ui.notify("Usage: /breakdown <filepath>", "error");
				return;
			}

			const resolvedPath = filePath.startsWith("~")
				? join(os.homedir(), filePath.slice(1))
				: filePath;

			if (!existsSync(resolvedPath)) {
				ctx.ui.notify(`File not found: ${resolvedPath}`, "error");
				return;
			}

			try {
				const result = await runPipeline(resolvedPath, ctx.cwd, ctx);
				ctx.ui.notify(
					`✓ Done! — ${result.projectName} (${result.totalStoryPoints} SP)\n→ ${basename(result.recPath)}\n→ ${basename(result.breakdownPath)}\n→ ${basename(result.flowsPath)}`,
					"success"
				);
			} catch (err: any) {
				ctx.ui.notify(`Pipeline failed: ${err.message}`, "error");
			}
		},
	});

	// ── before_agent_start: APPEND to existing system prompt ─────────────────
	// Pattern from purpose-gate.ts: event.systemPrompt + "\n\n..."
	// Never replace — replacing strips all default agent instructions.

	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: event.systemPrompt + `

## Breakdown Tool

You have access to \`run_breakdown\` — a multi-agent pipeline for processing client intake documents.

**Use run_breakdown immediately when:**
- The user shares or pastes a file path (any format: PDF, DOCX, MD, TXT, XLSX)
- The user asks to "break down", "analyze", "process", or "parse" a client document, brief, PRD, or spec
- The user mentions a client intake document or requirements doc

**Do NOT read or analyze the file yourself.** Always call run_breakdown — it handles everything: classification, user flow analysis, an optional PM interview about gaps, feature extraction, task generation, and consolidation.

The pipeline may pause to interview the user (the PM) about gaps it found — this is expected behavior, not an error.

After run_breakdown completes, summarize: project name, feature count, module count, total story points, and the three output file names.`,
		};
	});

	// ── session_start ──────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		// Clear old widget before reassigning ctx (pattern from agent-team.ts)
		if (widgetCtx) {
			widgetCtx.ui.setWidget("breakdown", undefined);
		}
		widgetCtx = ctx;
		resetSteps();
		updateWidget();

		ctx.ui.setStatus("breakdown", "ready");

		ctx.ui.setFooter((_tui: any, theme: any, _footerData: any) => ({
			dispose: () => {},
			invalidate() {},
			render(width: number): string[] {
				const model = ctx.model?.id || "no-model";
				const usage = ctx.getContextUsage();
				const pct = usage ? usage.percent : 0;
				const filled = Math.round(pct / 10);
				const bar = "#".repeat(filled) + "-".repeat(10 - filled);

				const activeStep = stepStates.find(s => s.status === "running");
				const stepLabel = activeStep
					? theme.fg("accent", activeStep.label)
					: theme.fg("dim", "breakdown");

				const left  = theme.fg("dim", ` ${model}`) + theme.fg("muted", " · ") + stepLabel;
				const right = theme.fg("dim", `[${bar}] ${Math.round(pct)}% `);
				const pad   = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));

				return [truncateToWidth(left + pad + right, width)];
			},
		}));

		ctx.ui.notify("Breakdown ready — drop a file or ask to analyze a document", "info");
	});
}
