import { loadBundle } from "./bundle.js";
import { classify, rollbackAction } from "./classify.js";
import { resolveLimits } from "./constants.js";
import { fail } from "./errors.js";
import { assertPosix, inspectFile, resolveInside, resolveTargetRoot } from "./fsutil.js";
import { Io } from "./io.js";
import { findLatestJournal, openJournal, readJournal } from "./journal-store.js";
import { withLock } from "./lock.js";
import {
	journaledPaths,
	publish,
	removeDirectories,
	removePublished,
	removeTemp,
	stageTemp,
	syncParents,
	tempPathFor,
} from "./publish.js";

/** @import { RollbackAction } from "./classify.js" */
/** @import { JournalFile } from "./journal.js" */
/** @import { JournalWriter } from "./journal-store.js" */
/** @import { FileOutcome, FileStatus, Limits, ProgressEvent, RollbackOptions, RollbackResult } from "./types.js" */

/**
 * @typedef {object} Context
 * @property {Io} io
 * @property {string} target
 * @property {Limits} limits
 * @property {(event: ProgressEvent) => void} progress
 */

/**
 * @typedef {object} Step
 * @property {JournalFile & { status: FileStatus }} file
 * @property {RollbackAction} action
 * @property {Buffer | null} original  verified backup bytes, for restores
 */

/**
 * Restores every file the bundle's latest apply changed: replaced files get
 * their original bytes and mode back, created files and directories are
 * removed. Works on a complete, incomplete or interrupted apply, and on an
 * interrupted rollback. Refuses, before changing anything, if a file apply
 * wrote has been edited since.
 * @param {RollbackOptions} options
 * @returns {Promise<RollbackResult>}
 */
export async function rollback(options) {
	assertPosix();
	const limits = resolveLimits(options.limits);
	const bundle = await loadBundle(options.bundle, limits);
	const target = await resolveTargetRoot(options.target);
	const io = new Io(target, options.faults);
	/** @type {Context} */
	const ctx = {
		io,
		target,
		limits,
		progress: options.onProgress ?? (() => {}),
	};
	return withLock(io, target, { command: "rollback", bundle: bundle.id }, async () => {
		const latest = await findLatestJournal(target, bundle.id);
		if (!latest) return result("nothing-to-roll-back", null, [], [], io);
		const view = await readJournal(target, latest.dir, {
			bundleId: bundle.id,
			generation: latest.generation,
		});
		if (view.state === "restored") return result("already-restored", null, [], [], io);
		const journal = await openJournal(io, latest.dir, view);
		try {
			return await runRollback(ctx, journal);
		} finally {
			await journal.close();
		}
	});
}

/**
 * @param {Context} ctx
 * @param {JournalWriter} journal
 * @returns {Promise<RollbackResult>}
 */
async function runRollback(ctx, journal) {
	const steps = await planSteps(ctx, journal);
	const conflicts = steps
		.filter((step) => step.action === "conflict")
		.map((step) => step.file.path);
	if (conflicts.length > 0) {
		fail(
			"CONFLICT",
			`Rollback refused: ${conflicts.join(", ")} changed after apply. Nothing was changed. Save those edits elsewhere and put back the applied content (or delete the file), then retry.`,
			{ files: conflicts },
		);
	}
	const resumed = journal.view.state === "restoring";
	await journal.appendState("restoring", resumed ? "resumed after interruption" : undefined);
	ctx.progress({ kind: "state", state: "restoring" });
	/** @type {FileOutcome[]} */
	const files = [];
	try {
		for (const step of steps.toReversed()) files.push(await rollbackFile(ctx, journal, step));
		const { removed, kept } = await removeDirectories(
			ctx.io,
			ctx.target,
			journal.view.header.directories,
		);
		for (const dir of removed) await journal.appendDir(dir, "removed");
		for (const dir of kept) await journal.appendDir(dir, "kept");
		await syncParents(ctx.io, ctx.target, journaledPaths(journal.view));
		await journal.appendState("restored");
		ctx.progress({ kind: "state", state: "restored" });
		return result("restored", journal.path, files.toReversed(), kept, ctx.io);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		await journal.appendError(`rollback stopped: ${reason}`).catch(() => undefined);
		throw error;
	}
}

/**
 * Decides every file's action up front (and loads every backup) so a
 * conflict or a damaged backup is found before anything is changed.
 * @param {Context} ctx
 * @param {JournalWriter} journal
 * @returns {Promise<Step[]>}
 */
async function planSteps(ctx, journal) {
	/** @type {Step[]} */
	const steps = [];
	for (const file of journal.view.files) {
		const content = classify(
			await inspectFile(ctx.target, file.path, ctx.limits.maxFileBytes),
			file,
			"content",
		);
		const action = rollbackAction(file, content);
		const original = action === "restore" ? await journal.readOriginal(file) : null;
		steps.push({ file, action, original });
	}
	return steps;
}

/**
 * @param {Context} ctx
 * @param {JournalWriter} journal
 * @param {Step} step
 * @returns {Promise<FileOutcome>}
 */
async function rollbackFile(ctx, journal, { file, action, original }) {
	const { io, target } = ctx;
	if (action === "leave")
		return { path: file.path, action: "left alone (changed by someone else)" };
	await removeTemp(io, await tempPathFor(target, file.path, file.temp), file.path);
	if (action === "none") {
		if (file.status !== "pending" && file.status !== "restored") {
			await journal.appendFile(file.index, "restored", "already original");
		}
		return { path: file.path, action: "unchanged" };
	}

	await journal.appendFile(file.index, "restoring");
	let outcome;
	if (action === "remove") {
		await expectContent(ctx, file, ["installed"]);
		await removePublished(io, (await resolveInside(target, file.path)).absolute, file.path);
		outcome = "removed";
	} else {
		if (original === null || file.original === null)
			return fail("INVALID_JOURNAL", `No backup for ${file.path}`);
		const staged = await stageTemp(io, target, file.path, file.temp, original, file.original.mode);
		const before = await expectContent(ctx, file, ["installed", "missing"]);
		await publish(io, {
			...staged,
			relative: file.path,
			how: before === "missing" ? "create" : "replace",
		});
		outcome = "restored";
	}
	await journal.appendFile(file.index, "restored");
	ctx.progress({
		kind: "file",
		phase: "rollback",
		path: file.path,
		action: outcome,
		index: file.index,
		total: journal.view.files.length,
	});
	return { path: file.path, action: outcome };
}

/**
 * Re-reads the file immediately before changing it.
 * @param {Context} ctx
 * @param {JournalFile} file
 * @param {readonly string[]} allowed
 */
async function expectContent(ctx, file, allowed) {
	const content = classify(
		await inspectFile(ctx.target, file.path, ctx.limits.maxFileBytes),
		file,
		"content",
	);
	if (!allowed.includes(content)) {
		fail("CONFLICT", `${file.path} changed during rollback (${content}); it was left untouched`, {
			path: file.path,
		});
	}
	return content;
}

/**
 * @param {RollbackResult["outcome"]} outcome
 * @param {string | null} journal
 * @param {FileOutcome[]} files
 * @param {string[]} keptDirectories
 * @param {Io} io
 * @returns {RollbackResult}
 */
function result(outcome, journal, files, keptDirectories, io) {
	return { outcome, journal, files, keptDirectories, io: io.stats };
}
