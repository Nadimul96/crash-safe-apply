import path from "node:path";
import { loadBundle } from "./bundle.js";
import { classify, rollbackAction } from "./classify.js";
import { JOURNAL_NAME, resolveLimits } from "./constants.js";
import { assertPosix, inspectFile, lstatMaybe, resolveTargetRoot } from "./fsutil.js";
import { findLatestJournal, readJournal } from "./journal-store.js";
import { readLock } from "./lock.js";
import { buildPlan } from "./plan.js";
import { tempPathFor } from "./publish.js";

/** @import { JournalView } from "./journal.js" */
/** @import { FileStatusReport, LockInfo, NextStep, OverallState, Plan, StatusReport, TargetOptions } from "./types.js" */

/**
 * Read-only report of where a bundle stands in a target: which journal state
 * it reached, what every file holds now, whether a run is active or crashed,
 * and which command finishes or undoes the change.
 * @param {TargetOptions} options
 * @returns {Promise<StatusReport>}
 */
export async function status(options) {
	assertPosix();
	const limits = resolveLimits(options.limits);
	const bundle = await loadBundle(options.bundle, limits);
	const target = await resolveTargetRoot(options.target);
	const lock = await readLock(target);
	const latest = await findLatestJournal(target, bundle.id);
	const base = { target, bundle: { id: bundle.id, name: bundle.name }, lock };

	if (!latest) {
		const { plan } = await buildPlan(bundle, target, limits);
		/** @type {NextStep[]} */
		const next = hasWork(plan)
			? [
					{
						command: "apply",
						plan: plan.id,
						reason: "apply the previewed plan",
					},
				]
			: [];
		return {
			...base,
			state: "not-applied",
			phase: null,
			journal: null,
			files: [],
			plan,
			rollbackBlockers: [],
			next,
		};
	}

	const view = await readJournal(target, latest.dir, {
		bundleId: bundle.id,
		generation: latest.generation,
	});
	const files = await Promise.all(
		view.files.map(async (file) => {
			const content = classify(
				await inspectFile(target, file.path, limits.maxFileBytes),
				file,
				"content",
			);
			const temp = await tempPathFor(target, file.path, file.temp).catch(() => null);
			const tempPresent = temp !== null && (await lstatMaybe(temp)) !== null;
			return {
				path: file.path,
				action: file.action,
				status: file.status,
				content,
				tempPresent,
			};
		}),
	);
	const rollbackBlockers = view.files
		.filter(
			(file, index) => rollbackAction(file, files[index]?.content ?? "modified") === "conflict",
		)
		.map((file) => file.path);
	const { state, phase } = overallState(view, lock, bundle.id);
	const plan = state === "restored" ? (await buildPlan(bundle, target, limits)).plan : null;
	return {
		...base,
		state,
		phase,
		journal: {
			path: path.join(latest.dir, JOURNAL_NAME),
			generation: latest.generation,
			state: view.state,
			planId: view.header.plan,
			records: view.records,
			updatedAt: view.updatedAt,
			discardedBytes: view.discardedBytes,
		},
		files,
		plan,
		rollbackBlockers,
		next: nextSteps(
			state,
			phase,
			view,
			files,
			rollbackBlockers,
			plan && hasWork(plan) ? plan.id : null,
		),
	};
}

/** @param {Plan} plan */
function hasWork(plan) {
	return plan.summary.create + plan.summary.replace > 0;
}

/**
 * The journal records the last durable state; whether a run is still active
 * comes from the lock. A non-terminal journal with no live lock holder means
 * the process died mid-way.
 * @param {JournalView} view
 * @param {LockInfo | null} lock
 * @param {string} bundleId
 * @returns {{ state: OverallState, phase: "apply" | "rollback" | null }}
 */
function overallState(view, lock, bundleId) {
	const active = lock?.alive === true && lock.bundle === bundleId;
	switch (view.state) {
		case "complete":
			return { state: "complete", phase: null };
		case "restored":
			return { state: "restored", phase: null };
		case "incomplete":
			return { state: "incomplete", phase: "apply" };
		case "restoring":
			return {
				state: active ? "in-progress" : "interrupted",
				phase: "rollback",
			};
		default:
			return { state: active ? "in-progress" : "interrupted", phase: "apply" };
	}
}

/**
 * @param {OverallState} state
 * @param {"apply" | "rollback" | null} phase
 * @param {JournalView} view
 * @param {FileStatusReport[]} files
 * @param {string[]} blockers
 * @param {string | null} freshPlan
 * @returns {NextStep[]}
 */
function nextSteps(state, phase, view, files, blockers, freshPlan) {
	/** @type {NextStep[]} */
	const steps = [];
	const canRollback = blockers.length === 0;
	const rollbackStep = /** @type {NextStep} */ ({
		command: "rollback",
		plan: null,
		reason: "restore every original file",
	});
	if (state === "in-progress") return steps;
	if (phase === "apply") {
		const drifted = files.some((file) => file.content === "modified" && file.status !== "pending");
		if (!drifted)
			steps.push({
				command: "apply",
				plan: view.header.plan,
				reason: "finish the interrupted apply",
			});
		if (canRollback) steps.push(rollbackStep);
	}
	if (phase === "rollback" && canRollback)
		steps.push({ ...rollbackStep, reason: "finish the interrupted rollback" });
	if (state === "complete" && canRollback) steps.push(rollbackStep);
	if (state === "restored" && freshPlan)
		steps.push({ command: "apply", plan: freshPlan, reason: "apply again" });
	return steps;
}
