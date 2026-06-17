/**
 * breakdown-lib.ts — Pure functions for the breakdown pipeline
 *
 * No pi imports here: everything in this file is testable with plain tsx
 * (`npx tsx extensions/breakdown.test.ts`). breakdown.ts wires these into
 * the extension runtime.
 */

import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { extname } from "path";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Feature {
	name: string;
	module: string;
	userType: string;
	divisions: string[];
	userFlows: string[];
	hasMissingFlow: boolean;
	isInfrastructure: boolean;
}

export interface Agent3Output {
	projectName: string;
	features: Feature[];
}

export interface PmAnswer {
	gap: string;
	answer: string;
}

// ── Parsing ────────────────────────────────────────────────────────────────────

export function slugify(name: string): string {
	return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

export function parseAgent3Json(rawOutput: string): Agent3Output {
	// Try ```json ... ``` fenced block first
	const fenceMatch = rawOutput.match(/```json\s*([\s\S]*?)```/);
	if (fenceMatch) {
		return JSON.parse(fenceMatch[1].trim()) as Agent3Output;
	}

	// Try raw JSON object containing "features" key
	const jsonMatch = rawOutput.match(/(\{[\s\S]*"features"[\s\S]*\})/);
	if (jsonMatch) {
		try { return JSON.parse(jsonMatch[1].trim()) as Agent3Output; } catch {}
	}

	// Try entire output as JSON
	try { return JSON.parse(rawOutput.trim()) as Agent3Output; } catch {}

	throw new Error(
		`Feature Extractor did not output valid JSON.\nGot: ${rawOutput.slice(0, 300)}`
	);
}

export function extractClientRecommendations(agent2Output: string): string {
	const match = agent2Output.match(/---CLIENT_RECOMMENDATIONS_START---\n([\s\S]*?)\n---CLIENT_RECOMMENDATIONS_END---/);
	if (!match) return "# Client Recommendations\n\nNo gaps identified.\n";
	return match[1].trim();
}

/** Extract the individual gap lines from Agent 2's "## Gaps Identified" section. */
export function parseGaps(agent2Output: string): string[] {
	const match = agent2Output.match(/## Gaps Identified\n([\s\S]*?)(?=\n---CLIENT_RECOMMENDATIONS_START---|\n## |$)/);
	if (!match) return [];
	return match[1]
		.split("\n")
		.map(l => l.trim())
		.filter(l => l.startsWith("- "))
		.map(l => l.slice(2).trim())
		.filter(l => l.length > 0 && !/^no gaps/i.test(l));
}

/**
 * Salvage features from truncated/malformed Agent 3 output.
 * Long feature lists can exceed the model's output limit, cutting the JSON
 * mid-stream — but every COMPLETE feature object before the cut is still
 * valid. Brace-match each object in the features array and keep the parseable ones.
 */
export function salvageAgent3Json(rawOutput: string): Agent3Output | null {
	const nameMatch = rawOutput.match(/"projectName"\s*:\s*"([^"]*)"/);
	const featIdx = rawOutput.indexOf('"features"');
	if (featIdx === -1) return null;
	const arrStart = rawOutput.indexOf("[", featIdx);
	if (arrStart === -1) return null;

	const features: Feature[] = [];
	let i = arrStart + 1;

	while (i < rawOutput.length) {
		const objStart = rawOutput.indexOf("{", i);
		if (objStart === -1) break;

		// Brace-match, string-aware
		let depth = 0, inStr = false, esc = false, end = -1;
		for (let j = objStart; j < rawOutput.length; j++) {
			const ch = rawOutput[j];
			if (esc) { esc = false; continue; }
			if (ch === "\\") { esc = true; continue; }
			if (ch === '"') { inStr = !inStr; continue; }
			if (inStr) continue;
			if (ch === "{") depth++;
			else if (ch === "}") { depth--; if (depth === 0) { end = j; break; } }
		}
		if (end === -1) break; // truncated object — everything after is lost

		try {
			const obj = JSON.parse(rawOutput.slice(objStart, end + 1));
			if (obj && typeof obj.name === "string" && typeof obj.module === "string") {
				features.push({
					name: obj.name,
					module: obj.module,
					userType: typeof obj.userType === "string" ? obj.userType : "",
					divisions: Array.isArray(obj.divisions) ? obj.divisions : ["Design", "FE", "BE", "QA"],
					userFlows: Array.isArray(obj.userFlows) ? obj.userFlows : [],
					hasMissingFlow: !!obj.hasMissingFlow,
					isInfrastructure: !!obj.isInfrastructure,
				});
			}
		} catch {}

		i = end + 1;
		// Stop at the features array's closing bracket
		const closeBracket = rawOutput.indexOf("]", end);
		const nextBrace = rawOutput.indexOf("{", end);
		if (closeBracket !== -1 && (nextBrace === -1 || closeBracket < nextBrace)) break;
	}

	if (features.length === 0) return null;
	return { projectName: nameMatch ? nameMatch[1] : "", features };
}

/**
 * Parse the gap-suggester's JSON output into per-gap option lists,
 * aligned by index with the gaps array (missing entries → empty list).
 */
export function parseGapOptions(rawOutput: string, gapCount: number): string[][] {
	let parsed: any;
	const fenceMatch = rawOutput.match(/```json\s*([\s\S]*?)```/);
	const candidate = fenceMatch ? fenceMatch[1].trim() : null;

	if (candidate) {
		try { parsed = JSON.parse(candidate); } catch {}
	}
	if (!parsed) {
		const objMatch = rawOutput.match(/(\{[\s\S]*"suggestions"[\s\S]*\})/);
		if (objMatch) {
			try { parsed = JSON.parse(objMatch[1].trim()); } catch {}
		}
	}
	if (!parsed) {
		try { parsed = JSON.parse(rawOutput.trim()); } catch {}
	}
	if (!parsed) throw new Error("Gap suggester did not output valid JSON");

	const list = Array.isArray(parsed) ? parsed : parsed.suggestions;
	if (!Array.isArray(list)) throw new Error("Gap suggester JSON has no suggestions array");

	const result: string[][] = [];
	for (let i = 0; i < gapCount; i++) {
		const entry = list[i];
		const options = Array.isArray(entry) ? entry : entry?.options;
		result.push(
			Array.isArray(options)
				? options.filter((o: any) => typeof o === "string" && o.trim()).map((o: string) => o.trim())
				: []
		);
	}
	return result;
}

// ── Output Builders ────────────────────────────────────────────────────────────

/** Sum all "**Story Points:** N" occurrences in a markdown string. */
export function sumStoryPoints(markdown: string): number {
	let total = 0;
	for (const m of markdown.matchAll(/\*\*Story Points:\*\*\s*(\d+)/g)) {
		total += parseInt(m[1], 10);
	}
	return total;
}

export function buildTaskBreakdown(
	projectName: string,
	agent4Outputs: Array<{ feature: Feature; markdown: string }>
): string {
	const byModule = new Map<string, typeof agent4Outputs>();
	for (const item of agent4Outputs) {
		const mod = item.feature.module;
		if (!byModule.has(mod)) byModule.set(mod, []);
		byModule.get(mod)!.push(item);
	}

	// Estimation summary — per module task count + story points, with grand total
	const summaryRows: string[] = [];
	let totalTasks = 0;
	let totalSP = 0;
	for (const [module, items] of byModule) {
		const md = items.map(i => i.markdown).join("\n");
		const tasks = (md.match(/^### /gm) || []).length;
		const sp = sumStoryPoints(md);
		totalTasks += tasks;
		totalSP += sp;
		summaryRows.push(`| ${module} | ${tasks} | ${sp} |`);
	}

	const lines: string[] = [
		`# ${projectName} — Task Breakdown`,
		"",
		"> ⚠️ Items marked [PENDING] depend on client answers in the client-recommendations file.",
		"> Items marked [ASSUMPTION] were inferred — verify before dev starts.",
		"",
		"## Estimation Summary",
		"",
		"| Module | Parent Tasks | Story Points |",
		"|---|---|---|",
		...summaryRows,
		`| **Total** | **${totalTasks}** | **${totalSP}** |`,
		"",
		"---",
		"",
	];

	for (const [module, items] of byModule) {
		const md = items.map(i => i.markdown).join("\n");
		const sp = sumStoryPoints(md);
		const tasks = (md.match(/^### /gm) || []).length;
		lines.push(`## Module: ${module}`, "");
		lines.push(`> ${tasks} parent tasks · ${sp} story points`, "");
		for (const item of items) {
			lines.push(item.markdown, "");
		}
	}

	return lines.join("\n");
}

/**
 * Build the standalone user-flows artifact from Agent 2's output.
 * Flows are the backbone: this file feeds PoC scoping, clickable
 * prototypes, and UAT test case generation.
 */
export function buildUserFlowsDoc(projectName: string, agent2Output: string): string {
	const flowsMatch = agent2Output.match(/## User Flows Found\n([\s\S]*?)(?=\n## Gaps Identified|\n---CLIENT_RECOMMENDATIONS_START---|$)/);
	const flows = flowsMatch ? flowsMatch[1].trim() : "(no flows found)";

	const gaps = parseGaps(agent2Output);
	const gapsSection = gaps.length > 0
		? gaps.map(g => `- ${g}`).join("\n")
		: "No gaps identified.";

	return [
		`# ${projectName} — User Flows`,
		"",
		"> Backbone artifact. Use for PoC scoping (pick the critical flows),",
		"> clickable prototype tasks, and UAT test case generation.",
		"",
		"## Flows",
		"",
		flows,
		"",
		"## Known Gaps",
		"",
		gapsSection,
		"",
	].join("\n");
}

/** Append PM interview answers to the client recommendations document. */
export function appendPmAnswers(clientRecommendations: string, pmAnswers: PmAnswer[]): string {
	if (pmAnswers.length === 0) return clientRecommendations;
	const resolved = pmAnswers
		.map(a => `- **Gap:** ${a.gap}\n  **Resolved:** ${a.answer}`)
		.join("\n");
	return `${clientRecommendations}\n\n---\n\n## Resolved Internally (PM)\n\nThese gaps were answered by the PM during intake — no client input needed. Listed for traceability.\n\n${resolved}\n`;
}

/** Format PM answers as an authoritative context block for downstream agents. */
export function formatPmAnswersBlock(pmAnswers: PmAnswer[]): string {
	if (pmAnswers.length === 0) return "";
	const body = pmAnswers
		.map(a => `- Gap: ${a.gap}\n  Answer: ${a.answer}`)
		.join("\n");
	return `\n\n---PM_ANSWERS--- (authoritative — resolved by the project manager, treat as confirmed requirements)\n${body}`;
}

// ── Document Extraction (deterministic — no LLM involved) ─────────────────────
// File-to-text conversion is a code problem, not a judgment problem.
// Doing it here means small models can't fumble it.

export function extractDocumentText(resolvedPath: string): string {
	const ext = extname(resolvedPath).toLowerCase();

	if (ext === ".pdf") {
		// PyMuPDF first — path passed via argv so spaces/parens are safe
		const fitz = spawnSync("python3", [
			"-c",
			"import sys, fitz; doc = fitz.open(sys.argv[1]); print('\\n'.join(p.get_text() for p in doc))",
			resolvedPath,
		], { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });
		if (fitz.status === 0 && fitz.stdout.trim()) return fitz.stdout;

		const pdftotext = spawnSync("pdftotext", [resolvedPath, "-"], {
			encoding: "utf-8", maxBuffer: 50 * 1024 * 1024,
		});
		if (pdftotext.status === 0 && pdftotext.stdout.trim()) return pdftotext.stdout;

		throw new Error(`Could not extract text from PDF. Install PyMuPDF (pip3 install pymupdf) or poppler (brew install poppler).`);
	}

	if (ext === ".docx") {
		const docx = spawnSync("python3", [
			"-c",
			"import sys, docx; print('\\n'.join(p.text for p in docx.Document(sys.argv[1]).paragraphs))",
			resolvedPath,
		], { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });
		if (docx.status === 0 && docx.stdout.trim()) return docx.stdout;
		throw new Error(`Could not extract text from DOCX. Install python-docx (pip3 install python-docx).`);
	}

	// .md, .txt, .csv, etc — read directly
	return readFileSync(resolvedPath, "utf-8");
}
