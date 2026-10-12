#!/usr/bin/env node
// Runs the demo session against the real CLI and renders it as an animated
// SVG terminal (CSS keyframes, no dependencies) at docs/media/demo.svg.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSession } from "./demo-session.js";

/** @import { Scene } from "./demo-session.js" */

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(repo, "docs", "media", "demo.svg");

const FONT_SIZE = 13;
const CHAR = FONT_SIZE * 0.61;
const LINE = 19;
const PAD_X = 18;
const TOP = 46;
const BOTTOM = 18;
const TITLES = ["preview", "apply, killed mid-way", "status after the crash", "rollback", "verify"];
const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[([0-9;]*)m`, "g");

/**
 * @typedef {{ text: string, classes: string[] }} Segment
 * @typedef {{ segments: Segment[], at: number, kind: "note" | "command" | "output" }} Row
 */

/**
 * Splits ANSI-colored text into lines of styled segments.
 * @param {string} text
 * @returns {Segment[][]}
 */
function parseAnsi(text) {
	/** @type {Segment[][]} */
	const lines = [[]];
	const style = { bold: false, dim: false, color: "" };
	let last = 0;
	const push = (/** @type {string} */ chunk) => {
		const parts = chunk.split("\n");
		parts.forEach((part, index) => {
			if (index > 0) lines.push([]);
			if (part === "") return;
			const classes = [style.bold ? "b" : "", style.dim ? "d" : "", style.color].filter(Boolean);
			lines[lines.length - 1]?.push({ text: part, classes });
		});
	};
	for (const match of text.matchAll(SGR)) {
		push(text.slice(last, match.index));
		last = match.index + match[0].length;
		for (const code of (match[1] || "0").split(";").map(Number)) {
			if (code === 0) Object.assign(style, { bold: false, dim: false, color: "" });
			else if (code === 1) style.bold = true;
			else if (code === 2) style.dim = true;
			else if (code === 22) Object.assign(style, { bold: false, dim: false });
			else if (code === 39) style.color = "";
			else if (code >= 31 && code <= 36)
				style.color = ["red", "green", "yellow", "blue", "magenta", "cyan"][code - 31] ?? "";
		}
	}
	push(text.slice(last));
	while (lines.length > 0 && lines[lines.length - 1]?.length === 0) lines.pop();
	return lines;
}

/** @param {string} value */
const xml = (value) =>
	value.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);

/**
 * Lays out one scene: when each row appears and when the scene ends.
 * @param {Scene} scene
 * @param {number} start  seconds
 */
function timeScene(scene, start) {
	const typingStart = start + 0.5;
	const typing = Math.min(1.8, scene.command.length * 0.028);
	const outputStart = typingStart + typing + 0.35;
	/** @type {Row[]} */
	const rows = [
		{ kind: "note", at: start, segments: [{ text: `# ${scene.note}`, classes: ["d"] }] },
		{
			kind: "command",
			at: start,
			segments: [
				{ text: "$ ", classes: ["green", "b"] },
				{ text: scene.command, classes: ["b"] },
			],
		},
	];
	let at = outputStart;
	for (const segments of parseAnsi(scene.output)) {
		const plain = segments.map((s) => s.text).join("");
		const isWork =
			/^\s+[+~-] (created|replaced|restored|removed)/.test(plain) || /^\s+journal/.test(plain);
		at += plain.startsWith("Killed") ? 0.7 : isWork ? 0.42 : 0.045;
		rows.push({ kind: "output", at, segments });
	}
	const hold = scene.command.startsWith("crash-safe-apply status") ? 5.2 : scene.killed ? 3.4 : 3;
	return { rows, typingStart, typing, outputStart, end: at + hold };
}

/**
 * @param {Scene[]} scenes
 */
function render(scenes) {
	/** @type {Array<ReturnType<typeof timeScene> & { scene: Scene, start: number }>} */
	const timed = [];
	let clock = 0.3;
	for (const scene of scenes) {
		const t = timeScene(scene, clock);
		timed.push({ ...t, scene, start: clock });
		clock = t.end + 0.25;
	}
	const total = clock + 0.4;
	const pct = (/** @type {number} */ seconds) => ((seconds / total) * 100).toFixed(3);
	const width = Math.max(
		...timed.flatMap((t) => t.rows.map((r) => r.segments.map((s) => s.text).join("").length)),
	);
	const rowsMax = Math.max(...timed.map((t) => t.rows.length));
	const W = Math.ceil(width * CHAR + PAD_X * 2 + 8);
	const H = TOP + rowsMax * LINE + BOTTOM;

	/** @type {string[]} */
	const css = [];
	/** @type {string[]} */
	const body = [];
	/** Visible from `from` to `to` seconds, hidden otherwise. */
	const window = (
		/** @type {string} */ name,
		/** @type {number} */ from,
		/** @type {number} */ to,
	) => {
		const a = pct(from);
		const b = pct(to);
		css.push(
			`.${name}{animation:${name} ${total.toFixed(2)}s linear infinite}`,
			`@keyframes ${name}{0%,${a}%{opacity:0}${(Number(a) + 0.001).toFixed(3)}%,${b}%{opacity:1}${(Number(b) + 0.001).toFixed(3)}%,100%{opacity:0}}`,
		);
	};

	timed.forEach((t, sceneIndex) => {
		const sceneClass = `s${sceneIndex}`;
		window(sceneClass, t.start, t.end);
		const poster = sceneIndex === 2 ? " poster" : "";
		const lines = [];
		lines.push(
			`<text class="title-step" x="${W - PAD_X}" y="24" text-anchor="end">step ${sceneIndex + 1} of ${timed.length} · ${xml(TITLES[sceneIndex] ?? "")}</text>`,
		);
		t.rows.forEach((row, rowIndex) => {
			const y = TOP + rowIndex * LINE + FONT_SIZE;
			const name = `${sceneClass}r${rowIndex}`;
			if (row.kind === "output") window(name, row.at, t.end);
			const spans = row.segments
				.map(
					(s) =>
						`<tspan${s.classes.length ? ` class="${s.classes.join(" ")}"` : ""}>${xml(s.text)}</tspan>`,
				)
				.join("");
			lines.push(
				`<text class="line${row.kind === "output" ? ` ${name}` : ""}" x="${PAD_X}" y="${y}">${spans}</text>`,
			);
			if (row.kind === "command") {
				const x = PAD_X + 2 * CHAR;
				const span = t.scene.command.length * CHAR;
				const steps = t.scene.command.length;
				const cover = `${sceneClass}c`;
				const cursor = `${sceneClass}k`;
				window(`${cursor}v`, t.start, t.outputStart);
				css.push(
					`.${cover},.${cursor}{animation:${cover} ${total.toFixed(2)}s linear infinite}`,
					`@keyframes ${cover}{0%,${pct(t.typingStart)}%{transform:translateX(0);animation-timing-function:steps(${steps},end)}${pct(t.typingStart + t.typing)}%,100%{transform:translateX(${span.toFixed(1)}px)}}`,
				);
				lines.push(
					`<rect class="cover ${cover}" x="${x.toFixed(1)}" y="${y - FONT_SIZE}" width="${(span + CHAR).toFixed(1)}" height="${LINE}"/>`,
					`<g class="${cursor}v"><rect class="cursor ${cursor}" x="${x.toFixed(1)}" y="${y - FONT_SIZE + 1}" width="${CHAR.toFixed(1)}" height="${FONT_SIZE + 3}"/></g>`,
				);
			}
		});
		body.push(`<g class="scene ${sceneClass}${poster}">${lines.join("")}</g>`);
	});

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Terminal recording: crash-safe-apply previews a bundle, an apply is killed with SIGKILL mid-way, status reports it as interrupted, and rollback restores a byte-identical directory.">
<style>
text{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace;font-size:${FONT_SIZE}px;fill:#d7dae0;white-space:pre}
.b{font-weight:700;fill:#f4f5f7}.d{fill:#7d8590}.red{fill:#ff7b72}.green{fill:#56d364}.yellow{fill:#e3b341}.cyan{fill:#56d4dd}.blue{fill:#79c0ff}.magenta{fill:#d2a8ff}
.title{fill:#8b929c;font-size:12px}.title-step{fill:#8b929c;font-size:12px}
.cover{fill:#0f1115}.cursor{fill:#c9d1d9}
${css.join("\n")}
@media (prefers-reduced-motion:reduce){*{animation:none!important}.scene{opacity:0}.scene.poster{opacity:1}.cover,.cursor{display:none}}
</style>
<clipPath id="window"><rect width="${W}" height="${H}" rx="10"/></clipPath>
<rect width="${W}" height="${H}" rx="10" fill="#0f1115"/>
<rect width="${W}" height="34" rx="10" fill="#1a1d23"/><rect y="24" width="${W}" height="10" fill="#1a1d23"/>
<line x1="0" y1="34" x2="${W}" y2="34" stroke="#262a31"/>
<circle cx="20" cy="17" r="6" fill="#ff5f57"/><circle cx="40" cy="17" r="6" fill="#febc2e"/><circle cx="60" cy="17" r="6" fill="#28c840"/>
<text class="title" x="80" y="21">crash-safe-apply · kill -9 mid-apply, then roll back</text>
<g clip-path="url(#window)">
${body.join("\n")}
</g>
</svg>
`;
}

const scenes = await runSession();
if (!scenes[1]?.killed) throw new Error("the apply was not killed mid-way; rerun");
const svg = render(scenes);
await fs.writeFile(OUT, svg);
process.stdout.write(`Wrote ${path.relative(repo, OUT)} (${(svg.length / 1024).toFixed(1)} KiB)\n`);
