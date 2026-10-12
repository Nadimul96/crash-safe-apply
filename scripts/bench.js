#!/usr/bin/env node
// Measures apply and rollback for bundles of 10, 100 and 500 files of 4 KiB
// (half replacing existing files, half creating new ones). Prints a markdown
// table with the median of three runs and the fsync counts.
//
//   pnpm bench
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { apply, preview, rollback } from "../src/index.js";
import { writeBundle } from "../test/support/bundles.js";
import { writeTree } from "../test/support/tree.js";

const SIZES = [10, 100, 500];
const RUNS = 3;
const FILE_BYTES = 4096;

/** @param {number[]} values */
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

/** @param {number} count */
async function measure(count) {
	const applyMs = [];
	const rollbackMs = [];
	let io = { fsyncs: 0, dirFsyncs: 0 };
	let rollbackIo = { fsyncs: 0, dirFsyncs: 0 };
	for (let run = 0; run < RUNS; run += 1) {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "csa-bench-")));
		try {
			const target = path.join(root, "target");
			/** @type {Record<string, string>} */
			const existing = {};
			/** @type {Record<string, string>} */
			const bundled = {};
			for (let i = 0; i < count; i += 1) {
				const file = `dir${i % 10}/file${i}.conf`;
				if (i % 2 === 0) existing[file] = "o".repeat(FILE_BYTES);
				bundled[file] = String(i % 10).repeat(FILE_BYTES);
			}
			await writeTree(target, existing);
			const bundle = await writeBundle(path.join(root, "bundle"), bundled);
			const plan = await preview({ bundle, target });
			let start = performance.now();
			const applied = await apply({ bundle, target, plan: plan.id });
			applyMs.push(performance.now() - start);
			start = performance.now();
			const rolled = await rollback({ bundle, target });
			rollbackMs.push(performance.now() - start);
			io = applied.io;
			rollbackIo = rolled.io;
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}
	return { count, apply: median(applyMs), rollback: median(rollbackMs), io, rollbackIo };
}

const rows = [];
for (const count of SIZES) rows.push(await measure(count));
const machine = `${os.cpus()[0]?.model ?? "unknown CPU"}, ${os.type()} ${os.release()} (${os.arch()}), Node ${process.version}`;
const lines = [
	`Measured ${new Date().toISOString().slice(0, 10)} on ${machine}, in the OS temp directory. Median of ${RUNS} runs.`,
	"",
	"| Files (4 KiB each) | apply | file fsyncs | dir fsyncs | rollback | file fsyncs | dir fsyncs |",
	"|--:|--:|--:|--:|--:|--:|--:|",
	...rows.map(
		(r) =>
			`| ${r.count} | ${r.apply.toFixed(0)} ms | ${r.io.fsyncs} | ${r.io.dirFsyncs} | ${r.rollback.toFixed(0)} ms | ${r.rollbackIo.fsyncs} | ${r.rollbackIo.dirFsyncs} |`,
	),
];
process.stdout.write(`${lines.join("\n")}\n`);
