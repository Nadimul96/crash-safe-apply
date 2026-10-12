import path from "node:path";
import { DEFAULT_DIR_MODE } from "./constants.js";
import { fail, isErrno } from "./errors.js";
import { lstatMaybe, resolveInside } from "./fsutil.js";

/** @import { Io } from "./io.js" */

/**
 * Per-file primitives shared by apply and rollback. Each new version of a file
 * is first written in full to a temp file in the destination's directory and
 * fsynced, then published under its real name in one step:
 *
 *   replace  rename(2) over the existing file. Atomic: any reader, and the
 *            disk after a crash, sees the complete old file or the complete
 *            new one. The name never disappears.
 *   create   link(2) the temp to the destination, then unlink the temp.
 *            Atomic and no-clobber: the kernel fails with EEXIST if anything
 *            appeared at the destination after we checked.
 *
 * Both finish by fsyncing the parent directory, which makes the new directory
 * entry durable.
 */

/**
 * @param {Io} io
 * @param {string} target
 * @param {string} relative
 * @param {string} tempBase   deterministic temp basename recorded in the journal
 * @param {Uint8Array} data
 * @param {number} mode
 * @returns {Promise<{ absolute: string, temp: string }>}
 */
export async function stageTemp(io, target, relative, tempBase, data, mode) {
	const { absolute } = await resolveInside(target, relative);
	const temp = path.join(path.dirname(absolute), tempBase);
	await removeTemp(io, temp, relative);
	await io.writeNewFile(temp, data, mode, `stage ${relative}`);
	return { absolute, temp };
}

/**
 * @param {Io} io
 * @param {{ absolute: string, temp: string, relative: string, how: "replace" | "create" }} file
 */
export async function publish(io, { absolute, temp, relative, how }) {
	if (how === "replace") {
		await io.rename(temp, absolute, `publish ${relative}`);
	} else {
		try {
			await io.link(temp, absolute, `publish ${relative}`);
		} catch (error) {
			if (!(isErrno(error) && error.code === "EEXIST")) throw error;
			await io.unlink(temp, `discard temp for ${relative}`);
			fail("CONFLICT", `${relative} appeared after it was checked; it was left untouched`, {
				path: relative,
			});
		}
		await io.unlink(temp, `remove temp for ${relative}`);
	}
	await io.syncDirectory(path.dirname(absolute), `persist ${relative}`);
}

/**
 * @param {Io} io
 * @param {string} absolute
 * @param {string} relative
 */
export async function removePublished(io, absolute, relative) {
	await io.unlink(absolute, `remove ${relative}`);
	await io.syncDirectory(path.dirname(absolute), `persist removal of ${relative}`);
}

/**
 * Removes a temp file left by an interrupted write. Its name is ours, but we
 * still refuse to unlink anything that is not a regular file.
 * @param {Io} io
 * @param {string} temp
 * @param {string} relative
 */
export async function removeTemp(io, temp, relative) {
	const stat = await lstatMaybe(temp);
	if (!stat) return;
	if (!stat.isFile()) fail("UNSAFE_PATH", `Unexpected non-file at the temp path for ${relative}`);
	await io.unlink(temp, `remove leftover temp for ${relative}`);
}

/**
 * @param {string} target
 * @param {string} relative
 * @param {string} tempBase
 */
export async function tempPathFor(target, relative, tempBase) {
	const { absolute } = await resolveInside(target, relative);
	return path.join(path.dirname(absolute), tempBase);
}

/**
 * Creates missing parent directories, parents first. Each new directory's
 * parent is fsynced so the directory survives a power cut along with the files
 * that will be published inside it.
 * @param {Io} io
 * @param {string} target
 * @param {readonly string[]} directories
 * @param {(relative: string) => Promise<void>} onCreated
 */
export async function createDirectories(io, target, directories, onCreated) {
	for (const relative of directories) {
		const resolved = await resolveInside(target, relative);
		if (resolved.stat) {
			if (!resolved.stat.isDirectory())
				fail("UNSAFE_PATH", `${relative} exists and is not a directory`);
			continue;
		}
		await io.mkdir(resolved.absolute, DEFAULT_DIR_MODE, `create directory ${relative}`);
		await io.syncDirectory(path.dirname(resolved.absolute), `persist directory ${relative}`);
		await onCreated(relative);
	}
}

/**
 * Removes directories apply created, deepest first, but only if they are
 * empty: a directory that gained someone else's files is kept.
 * @param {Io} io
 * @param {string} target
 * @param {readonly string[]} directories  parents first, as recorded by apply
 * @returns {Promise<{ removed: string[], kept: string[] }>}
 */
export async function removeDirectories(io, target, directories) {
	/** @type {string[]} */
	const removed = [];
	/** @type {string[]} */
	const kept = [];
	for (const relative of [...directories].reverse()) {
		const resolved = await resolveInside(target, relative).catch(() => null);
		if (resolved === null || (resolved.stat && !resolved.stat.isDirectory())) {
			kept.push(relative);
			continue;
		}
		if (!resolved.stat) continue;
		try {
			await io.rmdir(resolved.absolute, `remove directory ${relative}`);
		} catch (error) {
			if (isErrno(error) && (error.code === "ENOTEMPTY" || error.code === "EEXIST")) {
				kept.push(relative);
				continue;
			}
			throw error;
		}
		await io.syncDirectory(path.dirname(resolved.absolute), `persist removal of ${relative}`);
		removed.push(relative);
	}
	return { removed, kept };
}
