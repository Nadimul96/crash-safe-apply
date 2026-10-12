import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { STATE_DIR } from "./constants.js";
import { fail, isErrno } from "./errors.js";
import { assertPrivateDirectory, lstatMaybe } from "./fsutil.js";

/** @import { Io } from "./io.js" */
/** @import { LockInfo } from "./types.js" */

const LOCK_NAME = "lock";

/**
 * Runs active in this process. A lock that names this pid but no active run
 * was left behind by a run that died mid-way (in tests, a simulated crash).
 * @type {Set<string>}
 */
const activeRuns = new Set();

/**
 * Holds the target's lock for the duration of `run`. A crash leaves the lock
 * file behind; the next run sees that its holder is gone and clears it.
 * @template T
 * @param {Io} io
 * @param {string} target
 * @param {{ command: string, bundle: string }} purpose
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
export async function withLock(io, target, purpose, run) {
	const stateDir = await ensureStateDirectory(io, target);
	const lock = await acquire(io, stateDir, purpose);
	activeRuns.add(lock.runId);
	try {
		return await run();
	} finally {
		activeRuns.delete(lock.runId);
		await release(io, stateDir, lock.runId);
	}
}

/**
 * @param {string} target
 * @returns {Promise<LockInfo | null>}
 */
export async function readLock(target) {
	return readLockFile(path.join(target, STATE_DIR, LOCK_NAME));
}

/**
 * @param {Io} io
 * @param {string} target
 */
async function ensureStateDirectory(io, target) {
	const directory = path.join(target, STATE_DIR);
	if (!(await lstatMaybe(directory))) {
		try {
			await io.mkdir(directory, 0o700, "create state directory");
			await io.syncDirectory(target, "persist state directory");
		} catch (error) {
			if (!(isErrno(error) && error.code === "EEXIST")) throw error;
		}
	}
	await assertPrivateDirectory(directory);
	return directory;
}

/**
 * The lock's content is written to a temp file and published with link(2),
 * so the name `lock` never refers to a partially written file.
 * @param {Io} io
 * @param {string} stateDir
 * @param {{ command: string, bundle: string }} purpose
 */
async function acquire(io, stateDir, purpose) {
	const info = {
		pid: process.pid,
		host: os.hostname(),
		runId: randomUUID(),
		command: purpose.command,
		bundle: purpose.bundle,
		startedAt: new Date().toISOString(),
	};
	for (let attempt = 0; attempt < 2; attempt += 1) {
		if (await tryCreate(io, stateDir, info)) return info;
		const holder = await readLockFile(path.join(stateDir, LOCK_NAME));
		if (holder === null) continue;
		if (holder.alive) {
			fail(
				"LOCKED",
				`Another crash-safe-apply run holds the lock (${holder.command}, pid ${holder.pid} on ${holder.host}, since ${holder.startedAt}).`,
				{ holder },
			);
		}
		await breakStaleLock(io, stateDir, holder);
	}
	return fail("LOCKED", "Another run took the lock while a stale lock was being cleared. Retry.");
}

/**
 * @param {Io} io
 * @param {string} stateDir
 * @param {Omit<LockInfo, "alive">} info
 * @returns {Promise<boolean>}
 */
async function tryCreate(io, stateDir, info) {
	const temp = path.join(stateDir, `${LOCK_NAME}.${info.runId}.tmp`);
	// No fsync: after power loss the holder is gone anyway, and an unreadable lock counts as stale.
	await io.writeNewFile(temp, Buffer.from(JSON.stringify(info)), 0o600, "write lock", {
		sync: false,
	});
	try {
		await io.link(temp, path.join(stateDir, LOCK_NAME), "acquire lock");
		return true;
	} catch (error) {
		if (isErrno(error) && error.code === "EEXIST") return false;
		throw error;
	} finally {
		await io.unlink(temp, "remove lock temp");
	}
}

/**
 * Moves the stale lock aside first and checks that what moved is the lock we
 * judged stale. If another run replaced it in between, its lock is put back.
 * @param {Io} io
 * @param {string} stateDir
 * @param {LockInfo} stale
 */
async function breakStaleLock(io, stateDir, stale) {
	const lockPath = path.join(stateDir, LOCK_NAME);
	const aside = path.join(stateDir, `${LOCK_NAME}.stale-${randomUUID()}`);
	try {
		await io.rename(lockPath, aside, "move stale lock aside");
	} catch (error) {
		if (isErrno(error) && error.code === "ENOENT") return;
		throw error;
	}
	const moved = await readLockFile(aside);
	if (moved?.runId !== stale.runId) {
		await io.link(aside, lockPath, "restore live lock").catch(() => undefined);
		await io.unlink(aside, "remove moved lock");
		fail("LOCKED", "Another run took the lock while a stale lock was being cleared. Retry.");
	}
	await io.unlink(aside, "remove stale lock");
}

/**
 * Releases only our own lock. If the process is halted (simulated crash) the
 * unlink fails and the lock stays, exactly as it would after kill -9.
 * @param {Io} io
 * @param {string} stateDir
 * @param {string} runId
 */
async function release(io, stateDir, runId) {
	const lockPath = path.join(stateDir, LOCK_NAME);
	const current = await readLockFile(lockPath).catch(() => null);
	if (current?.runId !== runId) return;
	await io.unlink(lockPath, "release lock").catch(() => undefined);
}

/**
 * @param {string} file
 * @returns {Promise<LockInfo | null>}
 */
async function readLockFile(file) {
	let text;
	try {
		text = await fs.readFile(file, "utf8");
	} catch (error) {
		if (isErrno(error) && error.code === "ENOENT") return null;
		throw error;
	}
	const parsed = parseLock(text);
	if (!parsed) {
		return {
			pid: 0,
			host: "",
			runId: "",
			command: "unknown",
			bundle: "",
			startedAt: "",
			alive: false,
		};
	}
	return { ...parsed, alive: isAlive(parsed) };
}

/**
 * @param {string} text
 * @returns {Omit<LockInfo, "alive"> | null}
 */
function parseLock(text) {
	try {
		const value = JSON.parse(text);
		const valid =
			Number.isSafeInteger(value.pid) &&
			typeof value.host === "string" &&
			typeof value.runId === "string" &&
			typeof value.command === "string" &&
			typeof value.bundle === "string" &&
			typeof value.startedAt === "string";
		return valid ? value : null;
	} catch {
		return null;
	}
}

/** @param {Omit<LockInfo, "alive">} info */
function isAlive(info) {
	// Another machine's processes cannot be checked; assume the lock is live.
	if (info.host !== os.hostname()) return true;
	if (info.pid === process.pid) return activeRuns.has(info.runId);
	try {
		process.kill(info.pid, 0);
		return true;
	} catch (error) {
		return isErrno(error) && error.code === "EPERM";
	}
}
