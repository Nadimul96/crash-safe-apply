import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { apply } from "../../src/apply.js";
import { preview } from "../../src/preview.js";
import { rollback } from "../../src/rollback.js";
import { status } from "../../src/status.js";
import { crashAt, record, SimulatedCrash } from "./faults.js";
import { buildScenario } from "./scenario.js";
import { snapshot } from "./tree.js";

/** @import { FaultHook, FaultPoint } from "../../src/types.js" */
/** @import { Scenario } from "./scenario.js" */

/**
 * The fault-injection matrix. For an operation, first record every mutating
 * step it performs (every write, fsync, rename, link, unlink, mkdir; writes are
 * also split to model a torn write). Then, for each step, start from a fresh
 * copy of the scenario, crash right after that step, and check recovery:
 *
 *   - status must agree with the disk: "not-applied" only if the tree is the
 *     original, "complete" only if it is the applied tree, "restored" only if
 *     it is the original again;
 *   - rollback must restore a byte-identical original tree;
 *   - re-running apply must converge on the applied tree.
 *
 * A crash is modeled by the I/O layer refusing every mutation after the
 * hook throws, so no cleanup code runs, exactly as after kill -9.
 */

/**
 * @typedef {object} MatrixResult
 * @property {string} name
 * @property {FaultPoint[]} points     crash points exercised
 * @property {number} recoveries       recovery runs checked
 * @property {Record<string, number>} statusSeen
 */

/** @typedef {Scenario & { plan: string }} PreparedScenario */

// Each scenario has its own directories, and the work is bound by fsync
// latency, so independent crash points run concurrently.
const CONCURRENCY = Number(process.env.FAULT_MATRIX_CONCURRENCY ?? 8);

/**
 * @template T
 * @param {readonly T[]} items
 * @param {(item: T) => Promise<void>} task
 */
async function forEachConcurrently(items, task) {
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const item = /** @type {T} */ (items[next]);
			next += 1;
			await task(item);
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

/**
 * @template T
 * @param {(s: PreparedScenario) => Promise<T>} body
 * @returns {Promise<T>}
 */
async function withScenario(body) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "csa-fault-")));
	try {
		const s = await buildScenario(root);
		const { id } = await preview({ bundle: s.bundle, target: s.target });
		return await body({ ...s, plan: id });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

/** @param {PreparedScenario} s @param {FaultHook} [faults] */
const runApply = (s, faults) => apply({ bundle: s.bundle, target: s.target, plan: s.plan, faults });
/** @param {PreparedScenario} s @param {FaultHook} [faults] */
const runRollback = (s, faults) => rollback({ bundle: s.bundle, target: s.target, faults });

/**
 * @param {(s: PreparedScenario, faults: FaultHook) => Promise<unknown>} operation
 * @param {(s: PreparedScenario) => Promise<void>} [before]
 */
async function stepsOf(operation, before) {
	/** @type {FaultPoint[]} */
	const points = [];
	await withScenario(async (s) => {
		await before?.(s);
		await operation(s, record(points));
	});
	return points;
}

/**
 * Runs `operation` with a crash injected after step `point`. The run usually
 * rejects with the crash. The one exception is the final step (releasing the
 * lock), whose failure is deliberately ignored because the result is already
 * durable; there the hook must still have fired.
 * @param {(faults: FaultHook) => Promise<unknown>} operation
 * @param {FaultPoint} point
 */
async function expectCrash(operation, point) {
	let fired = false;
	const hook = crashAt(point.seq);
	const faults = (/** @type {FaultPoint} */ p) => {
		fired ||= p.seq === point.seq;
		return hook(p);
	};
	try {
		await operation(faults);
	} catch (error) {
		if (error instanceof SimulatedCrash && error.point.seq === point.seq) return;
		throw error;
	}
	assert.ok(fired && point.step === "release lock", `no crash happened at ${describePoint(point)}`);
}

/** @param {FaultPoint} p */
export const describePoint = (p) => `#${p.seq} ${p.op} ${p.path} (${p.step})`;

/**
 * @param {PreparedScenario} s
 * @param {Record<string, number>} seen
 * @param {string} context
 */
async function checkStatus(s, seen, context) {
	const report = await status({ bundle: s.bundle, target: s.target });
	const key = report.phase ? `${report.state} (${report.phase})` : report.state;
	seen[key] = (seen[key] ?? 0) + 1;
	const tree = await snapshot(s.target);
	if (report.state === "not-applied" || report.state === "restored")
		assert.deepEqual(
			tree,
			s.original,
			`${context}: status ${report.state} but tree differs from the original`,
		);
	if (report.state === "complete")
		assert.deepEqual(
			tree,
			s.expected,
			`${context}: status complete but tree differs from the applied tree`,
		);
	assert.ok(
		["not-applied", "interrupted", "complete", "restored"].includes(report.state),
		`${context}: unexpected status ${report.state}`,
	);
	return report;
}

/** Crash apply after every step; recover once by rollback and once by re-applying. */
export async function applyMatrix() {
	const points = await stepsOf(runApply);
	/** @type {Record<string, number>} */
	const statusSeen = {};
	let recoveries = 0;
	await forEachConcurrently(points, async (point) => {
		const context = `apply crash after ${describePoint(point)}`;
		await withScenario(async (s) => {
			await expectCrash((f) => runApply(s, f), point);
			await checkStatus(s, statusSeen, context);
			await runRollback(s);
			assert.deepEqual(
				await snapshot(s.target),
				s.original,
				`${context}: rollback did not restore the original tree`,
			);
			recoveries += 1;
		});
		await withScenario(async (s) => {
			await expectCrash((f) => runApply(s, f), point);
			await runApply(s);
			assert.deepEqual(
				await snapshot(s.target),
				s.expected,
				`${context}: re-running apply did not converge`,
			);
			assert.equal(
				(await status({ bundle: s.bundle, target: s.target })).state,
				"complete",
				context,
			);
			recoveries += 1;
		});
	});
	return { name: "apply", points, recoveries, statusSeen };
}

/** Crash rollback (of a complete apply) after every step; re-running rollback must finish it. */
export async function rollbackMatrix() {
	const applyFully = (/** @type {PreparedScenario} */ s) => runApply(s).then(() => undefined);
	const points = await stepsOf(runRollback, applyFully);
	/** @type {Record<string, number>} */
	const statusSeen = {};
	let recoveries = 0;
	await forEachConcurrently(points, async (point) => {
		const context = `rollback crash after ${describePoint(point)}`;
		await withScenario(async (s) => {
			await applyFully(s);
			await expectCrash((f) => runRollback(s, f), point);
			await checkStatus(s, statusSeen, context);
			await runRollback(s);
			assert.deepEqual(
				await snapshot(s.target),
				s.original,
				`${context}: second rollback did not restore the original tree`,
			);
			recoveries += 1;
		});
	});
	return { name: "rollback", points, recoveries, statusSeen };
}

/**
 * Two crashes in a row: apply crashes at a sampled step, then the recovery
 * itself (resume or rollback) crashes at every one of its steps. A third run
 * must still converge.
 * @param {number} samples  how many first-crash points to sample, spread evenly
 */
export async function doubleFaultMatrix(samples) {
	const first = await stepsOf(runApply);
	const picks = Array.from(
		{ length: samples },
		(_, i) => first[Math.floor(((i + 0.5) * first.length) / samples)],
	).filter((p) => p !== undefined);
	/** @type {FaultPoint[]} */
	const points = [];
	/** @type {Record<string, number>} */
	const statusSeen = {};
	let recoveries = 0;
	for (const firstPoint of picks) {
		const crashFirst = (/** @type {PreparedScenario} */ s) =>
			expectCrash((f) => runApply(s, f), firstPoint);
		for (const [name, recover, finish, expected] of /** @type {const} */ ([
			["resume", runApply, runApply, "expected"],
			["rollback", runRollback, runRollback, "original"],
		])) {
			const second = await stepsOf(recover, crashFirst);
			await forEachConcurrently(second, async (point) => {
				const context = `apply crash after ${describePoint(firstPoint)}, then ${name} crash after ${describePoint(point)}`;
				await withScenario(async (s) => {
					await crashFirst(s);
					await expectCrash((f) => recover(s, f), point);
					await checkStatus(s, statusSeen, context);
					await finish(s);
					assert.deepEqual(
						await snapshot(s.target),
						s[expected],
						`${context}: third run did not converge`,
					);
					recoveries += 1;
				});
			});
			points.push(...second);
		}
	}
	return { name: "double fault", points, recoveries, statusSeen };
}
