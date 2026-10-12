import { loadBundle } from "./bundle.js";
import { classify } from "./classify.js";
import { resolveLimits } from "./constants.js";
import { CrashSafeError, fail } from "./errors.js";
import { assertPosix, inspectFile, resolveTargetRoot } from "./fsutil.js";
import { Io } from "./io.js";
import { canTransition } from "./journal.js";
import { findLatestJournal, openJournal, prepareJournal, readJournal } from "./journal-store.js";
import { withLock } from "./lock.js";
import { buildPlan } from "./plan.js";
import {
	createDirectories,
	journaledPaths,
	publish,
	removeTemp,
	stageTemp,
	syncParents,
	tempPathFor,
} from "./publish.js";

/** @import { JournalFile, JournalView } from "./journal.js" */
/** @import { JournalWriter } from "./journal-store.js" */
/** @import { ApplyOptions, ApplyResult, Bundle, FileOutcome, Limits, ProgressEvent } from "./types.js" */

/**
 * @typedef {object} Context
 * @property {Io} io
 * @property {string} target
 * @property {Bundle} bundle
 * @property {Limits} limits
 * @property {(event: ProgressEvent) => void} progress
 */

const RESUMABLE = new Set(["prepared", "applying", "applied", "incomplete"]);

/**
 * Applies a bundle to a target directory.
 *
 * With `plan`, apply refuses unless the target is exactly as it was when
 * preview produced that plan id. If an earlier apply of the same bundle was
 * interrupted, apply continues it (converging on the same end state) instead
 * of starting again.
 * @param {ApplyOptions} options
 * @returns {Promise<ApplyResult>}
 */
export async function apply(options) {
	assertPosix();
	const limits = resolveLimits(options.limits);
	const bundle = await loadBundle(options.bundle, limits);
	const target = await resolveTargetRoot(options.target);
	const io = new Io(target, options.faults);
	/** @type {Context} */
	const ctx = {
		io,
		target,
		bundle,
		limits,
		progress: options.onProgress ?? (() => {}),
	};
	return withLock(io, target, { command: "apply", bundle: bundle.id }, async () => {
		const latest = await findLatestJournal(target, bundle.id);
		if (latest) {
			const view = await readJournal(target, latest.dir, {
				bundleId: bundle.id,
				generation: latest.generation,
			});
			const outcome = await continueExisting(ctx, latest.dir, view, options.plan);
			if (outcome) return outcome;
		}
		return startFresh(ctx, (latest?.generation ?? 0) + 1, options.plan);
	});
}

/**
 * @param {Context} ctx
 * @param {string} dir
 * @param {JournalView} view
 * @param {string | undefined} expectedPlan
 * @returns {Promise<ApplyResult | null>}  null when a new generation should start
 */
async function continueExisting(ctx, dir, view, expectedPlan) {
	if (view.state === "restored") return null;
	if (view.state === "restoring") {
		fail(
			"WRONG_PHASE",
			"A rollback of this bundle was interrupted. Run rollback to finish it first.",
		);
	}
	if (view.state === "complete") return alreadyApplied(ctx, view);
	if (expectedPlan !== undefined && expectedPlan !== view.header.plan) {
		fail(
			"PLAN_MISMATCH",
			`An interrupted apply of plan ${view.header.plan} exists for this bundle. Pass --plan ${view.header.plan} to finish it, or run rollback.`,
			{ expected: expectedPlan, journalPlan: view.header.plan },
		);
	}
	if (!RESUMABLE.has(view.state))
		fail("WRONG_PHASE", `Cannot resume a journal in state ${view.state}`);
	const journal = await openJournal(ctx.io, dir, view);
	try {
		return await runApply(ctx, journal, "content", "resumed");
	} finally {
		await journal.close();
	}
}

/**
 * @param {Context} ctx
 * @param {JournalView} view
 * @returns {Promise<ApplyResult>}
 */
async function alreadyApplied(ctx, view) {
	for (const file of view.files) {
		const content = classify(
			await inspectFile(ctx.target, file.path, ctx.limits.maxFileBytes),
			file,
			"content",
		);
		if (content !== "installed") {
			fail(
				"WRONG_PHASE",
				`This bundle was applied, but ${file.path} has changed since (${content}). Inspect it, or roll back first.`,
			);
		}
	}
	return {
		outcome: "already-applied",
		planId: view.header.plan,
		journal: null,
		files: view.files.map((file) => ({
			path: file.path,
			action: "already applied",
		})),
		io: ctx.io.stats,
	};
}

/**
 * @param {Context} ctx
 * @param {number} generation
 * @param {string | undefined} expectedPlan
 * @returns {Promise<ApplyResult>}
 */
async function startFresh(ctx, generation, expectedPlan) {
	const { plan, originalData } = await buildPlan(ctx.bundle, ctx.target, ctx.limits);
	if (expectedPlan !== undefined && expectedPlan !== plan.id) {
		fail(
			"PLAN_MISMATCH",
			`The target changed after preview: plan ${expectedPlan} was approved, but the target now gives plan ${plan.id}. Nothing was changed. Run preview again.`,
			{ expected: expectedPlan, actual: plan.id },
		);
	}
	if (plan.changes.every((change) => change.action === "unchanged")) {
		const files = plan.changes.map((change) => ({
			path: change.path,
			action: "unchanged",
		}));
		return {
			outcome: "nothing-to-do",
			planId: plan.id,
			journal: null,
			files,
			io: ctx.io.stats,
		};
	}
	const journal = await prepareJournal(
		ctx.io,
		ctx.target,
		ctx.bundle,
		plan,
		originalData,
		generation,
	);
	try {
		return await runApply(ctx, journal, "strict", "applied");
	} finally {
		await journal.close();
	}
}

/**
 * The apply state machine: prepared -> applying -> applied -> complete, or
 * incomplete if a file is not as expected. Every file is classified by its
 * current content first, so running this again after a crash converges.
 * @param {Context} ctx
 * @param {JournalWriter} journal
 * @param {"strict" | "content"} identity
 * @param {"applied" | "resumed"} outcome
 * @returns {Promise<ApplyResult>}
 */
async function runApply(ctx, journal, identity, outcome) {
	/** @type {FileOutcome[]} */
	const files = [];
	try {
		if (journal.view.state !== "applied") {
			await journal.appendState(
				"applying",
				outcome === "resumed" ? "resumed after interruption" : undefined,
			);
			ctx.progress({ kind: "state", state: "applying" });
			await createDirectories(ctx.io, ctx.target, journal.view.header.directories, (dir) =>
				journal.appendDir(dir, "created"),
			);
			for (const file of journal.view.files) {
				files.push(await applyFile(ctx, journal, file, identity));
			}
			await syncParents(ctx.io, ctx.target, journaledPaths(journal.view));
			await journal.appendState("applied");
			ctx.progress({ kind: "state", state: "applied" });
		}
		await verifyInstalled(ctx, journal.view);
		await journal.appendState("complete");
		ctx.progress({ kind: "state", state: "complete" });
	} catch (error) {
		await markIncomplete(journal, error);
		throw error;
	}
	return {
		outcome,
		planId: journal.view.header.plan,
		journal: journal.path,
		files,
		io: ctx.io.stats,
	};
}

/**
 * @param {Context} ctx
 * @param {JournalWriter} journal
 * @param {JournalFile & { status: string }} file
 * @param {"strict" | "content"} identity
 * @returns {Promise<FileOutcome>}
 */
async function applyFile(ctx, journal, file, identity) {
	const { io, target, limits } = ctx;
	const content = classify(
		await inspectFile(target, file.path, limits.maxFileBytes),
		file,
		identity,
	);
	if (content === "installed") {
		// Published before an interruption; only a leftover temp may remain.
		await removeTemp(io, await tempPathFor(target, file.path, file.temp), file.path);
		if (file.status !== "applied")
			await journal.appendFile(file.index, "applied", "already in place");
		return { path: file.path, action: "already in place" };
	}
	if (content !== "original") throw unexpectedContent(file.path, content, identity);

	await journal.appendFile(file.index, "applying");
	const data = bundleData(ctx.bundle, file);
	const staged = await stageTemp(io, target, file.path, file.temp, data, file.mode);
	// Last check before publishing: the window that remains is the gap between this read and rename(2).
	const latest = classify(
		await inspectFile(target, file.path, limits.maxFileBytes),
		file,
		identity,
	);
	if (latest !== "original") throw unexpectedContent(file.path, latest, identity);
	const how = file.action === "replace" ? "replace" : "create";
	await publish(io, { ...staged, relative: file.path, how });
	await journal.appendFile(file.index, "applied");
	const action = how === "replace" ? "replaced" : "created";
	ctx.progress({
		kind: "file",
		phase: "apply",
		path: file.path,
		action,
		index: file.index,
		total: journal.view.files.length,
	});
	return { path: file.path, action };
}

/**
 * `applied` means every file was published; `complete` means every file was
 * read back and matches the bundle.
 * @param {Context} ctx
 * @param {JournalView} view
 */
async function verifyInstalled(ctx, view) {
	for (const file of view.files) {
		const content = classify(
			await inspectFile(ctx.target, file.path, ctx.limits.maxFileBytes),
			file,
			"content",
		);
		if (content !== "installed") {
			fail("CONFLICT", `${file.path} no longer matches the bundle after apply (${content})`, {
				path: file.path,
			});
		}
	}
}

/**
 * @param {Bundle} bundle
 * @param {JournalFile} file
 */
function bundleData(bundle, file) {
	const entry = bundle.files.find((candidate) => candidate.path === file.path);
	if (!entry || entry.sha256 !== file.sha256) {
		return fail(
			"INVALID_JOURNAL",
			`The bundle does not contain the journaled content for ${file.path}`,
		);
	}
	return entry.data;
}

/**
 * @param {string} relative
 * @param {string} content
 * @param {"strict" | "content"} identity
 */
function unexpectedContent(relative, content, identity) {
	const what = content === "missing" ? "was deleted" : "was modified";
	if (identity === "strict") {
		return new CrashSafeError(
			"CHANGED_AFTER_PREVIEW",
			`${relative} ${what} after preview; it was left untouched`,
			{
				path: relative,
			},
		);
	}
	return new CrashSafeError(
		"CONFLICT",
		`${relative} ${what} by something else while the apply was interrupted; it was left untouched`,
		{ path: relative },
	);
}

/**
 * Best effort: if the process is halted (a simulated crash) or the disk is
 * failing, the journal stays in its last durable state, which is still safe.
 * @param {JournalWriter} journal
 * @param {unknown} error
 */
async function markIncomplete(journal, error) {
	if (!canTransition(journal.view.state, "incomplete")) return;
	const reason = error instanceof Error ? error.message : String(error);
	await journal.appendState("incomplete", reason).catch(() => undefined);
}
