import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { JOURNAL_FORMAT, JOURNAL_NAME, ORIGINALS_DIR, STATE_DIR } from "./constants.js";
import { fail, isErrno } from "./errors.js";
import { assertPrivateDirectory, lstatMaybe, readRegularFile } from "./fsutil.js";
import {
	applyRecord,
	canTransition,
	createView,
	decodeJournal,
	encodeRecord,
	tempName,
} from "./journal.js";

/** @import { FileHandle } from "node:fs/promises" */
/** @import { Io } from "./io.js" */
/** @import { JournalFile, JournalView, PreparedRecord, RecordBody } from "./journal.js" */
/** @import { Bundle, FileStatus, JournalState, Plan } from "./types.js" */

const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const GENERATION = /^[1-9]\d{0,5}$/;

/**
 * Layout inside the target:
 *
 *   .crash-safe-apply/
 *     lock
 *     <bundle id>/
 *       <generation>/            one per apply; a re-apply after rollback starts a new one
 *         journal.log
 *         originals/<index>      byte-for-byte copies of replaced files
 */

/**
 * @param {string} target
 * @param {string} bundleId
 * @returns {Promise<{ generation: number, dir: string } | null>}
 */
export async function findLatestJournal(target, bundleId) {
	const bundleDir = path.join(target, STATE_DIR, bundleId);
	let names;
	try {
		names = await fs.readdir(bundleDir);
	} catch (error) {
		if (isErrno(error) && error.code === "ENOENT") return null;
		throw error;
	}
	const generations = names.filter((name) => GENERATION.test(name)).map(Number);
	if (generations.length === 0) return null;
	const generation = Math.max(...generations);
	return { generation, dir: path.join(bundleDir, String(generation)) };
}

/**
 * @param {string} target
 * @param {string} dir
 * @param {{ bundleId: string, generation: number }} expected
 * @returns {Promise<JournalView>}
 */
export async function readJournal(target, dir, expected) {
	for (const directory of [path.join(target, STATE_DIR), path.dirname(dir), dir]) {
		await assertPrivateDirectory(directory);
	}
	const { data } = await readRegularFile(path.join(dir, JOURNAL_NAME), MAX_JOURNAL_BYTES);
	const view = decodeJournal(data);
	if (
		view.header.bundle.id !== expected.bundleId ||
		view.header.generation !== expected.generation
	) {
		fail("INVALID_JOURNAL", `Journal at ${dir} belongs to a different bundle or generation`);
	}
	return view;
}

/**
 * Writes every original and the "prepared" record inside a fresh directory,
 * fsyncs them, then renames the directory into place. So a generation
 * directory exists only once its backups and plan are durable, and nothing in
 * the target has been touched before that point.
 * @param {Io} io
 * @param {string} target
 * @param {Bundle} bundle
 * @param {Plan} plan
 * @param {Map<string, Buffer>} originalData
 * @param {number} generation
 * @returns {Promise<JournalWriter>}
 */
export async function prepareJournal(io, target, bundle, plan, originalData, generation) {
	const bundleDir = path.join(target, STATE_DIR, bundle.id);
	if (!(await lstatMaybe(bundleDir))) {
		await io.mkdir(bundleDir, 0o700, "create bundle journal directory");
		await io.syncDirectory(path.dirname(bundleDir), "persist bundle journal directory");
	}
	await assertPrivateDirectory(bundleDir);
	const staging = path.join(bundleDir, `.prepare-${randomUUID()}`);
	await io.mkdir(staging, 0o700, "create staging journal directory");
	await io.mkdir(path.join(staging, ORIGINALS_DIR), 0o700, "create originals directory");
	const header = preparedRecord(bundle, plan, generation);
	for (const file of header.files) {
		const data = originalData.get(file.path);
		if (file.backup === null || data === undefined) continue;
		await io.writeNewFile(path.join(staging, file.backup), data, 0o600, `back up ${file.path}`);
	}
	await io.syncDirectory(path.join(staging, ORIGINALS_DIR), "persist originals");
	await io.writeNewFile(
		path.join(staging, JOURNAL_NAME),
		encodeRecord(header),
		0o600,
		"journal: prepared",
	);
	await io.syncDirectory(staging, "persist staging journal directory");
	const dir = path.join(bundleDir, String(generation));
	await io.rename(staging, dir, "publish journal directory");
	await io.syncDirectory(bundleDir, "persist journal directory");
	const length = (await fs.stat(path.join(dir, JOURNAL_NAME))).size;
	return JournalWriter.open(io, dir, createView(header, length, 0));
}

/**
 * Opens an existing journal for appending. A torn tail left by a crash is
 * truncated first, so new records never follow garbage.
 * @param {Io} io
 * @param {string} dir
 * @param {JournalView} view
 * @returns {Promise<JournalWriter>}
 */
export async function openJournal(io, dir, view) {
	return JournalWriter.open(io, dir, view);
}

/**
 * @param {Bundle} bundle
 * @param {Plan} plan
 * @param {number} generation
 * @returns {PreparedRecord}
 */
function preparedRecord(bundle, plan, generation) {
	const writes = plan.changes.filter((change) => change.action !== "unchanged");
	return {
		seq: 1,
		at: new Date().toISOString(),
		type: "prepared",
		format: JOURNAL_FORMAT,
		bundle: { id: bundle.id, digest: bundle.digest, name: bundle.name },
		target: plan.target,
		plan: plan.id,
		generation,
		files: writes.map((change, index) => ({
			path: change.path,
			action: change.action === "create" ? "create" : "replace",
			sha256: change.sha256,
			size: change.size,
			mode: change.mode,
			original: change.original,
			backup: change.original ? `${ORIGINALS_DIR}/${index}` : null,
			temp: tempName(bundle.id, generation, index),
		})),
		directories: plan.directories,
		sync: true,
	};
}

/**
 * Appends records. State records are fsynced before the method returns,
 * because later steps depend on them. Per-file progress records are not:
 * recovery re-derives each file's state from its content, so a lost progress
 * record costs nothing, and the next fsync makes it durable anyway.
 */
export class JournalWriter {
	#io;
	#handle;

	/**
	 * @param {Io} io
	 * @param {FileHandle} handle
	 * @param {string} dir
	 * @param {JournalView} view
	 */
	constructor(io, handle, dir, view) {
		this.#io = io;
		this.#handle = handle;
		this.dir = dir;
		this.path = path.join(dir, JOURNAL_NAME);
		this.view = view;
	}

	/**
	 * @param {Io} io
	 * @param {string} dir
	 * @param {JournalView} view
	 */
	static async open(io, dir, view) {
		const file = path.join(dir, JOURNAL_NAME);
		const handle = await io.openForAppend(file);
		const writer = new JournalWriter(io, handle, dir, view);
		if (view.discardedBytes > 0) {
			await io.truncate(handle, file, view.validBytes, "journal: drop torn tail");
			view.discardedBytes = 0;
		}
		return writer;
	}

	/**
	 * @param {JournalState} state
	 * @param {string} [note]
	 */
	async appendState(state, note) {
		if (!canTransition(this.view.state, state)) {
			fail("WRONG_PHASE", `Journal cannot move from ${this.view.state} to ${state}`);
		}
		await this.#append({ type: "state", state, ...(note ? { note } : {}), sync: true }, true);
	}

	/**
	 * @param {number} index
	 * @param {FileStatus} status
	 * @param {string} [note]
	 */
	async appendFile(index, status, note) {
		await this.#append({ type: "file", index, status, ...(note ? { note } : {}) }, false);
	}

	/**
	 * @param {string} dirPath
	 * @param {"created" | "removed" | "kept"} status
	 */
	async appendDir(dirPath, status) {
		await this.#append({ type: "dir", path: dirPath, status }, false);
	}

	/** @param {string} message */
	async appendError(message) {
		await this.#append({ type: "error", message }, true);
	}

	/**
	 * Reads a backed-up original and checks it against the journal before it
	 * is used to restore anything.
	 * @param {JournalFile} file
	 * @returns {Promise<Buffer>}
	 */
	async readOriginal(file) {
		if (file.backup === null || file.original === null) {
			return fail("INVALID_JOURNAL", `${file.path} has no backup`);
		}
		const { data, fingerprint } = await readRegularFile(
			path.join(this.dir, file.backup),
			Math.max(file.original.size, 1),
		);
		if (fingerprint.sha256 !== file.original.sha256) {
			fail("INVALID_JOURNAL", `The backup of ${file.path} does not match its recorded sha256`);
		}
		return data;
	}

	async close() {
		await this.#handle.close();
	}

	/**
	 * @param {RecordBody} body
	 * @param {boolean} durable
	 */
	async #append(body, durable) {
		const record = {
			seq: this.view.lastSeq + 1,
			at: new Date().toISOString(),
			...body,
		};
		const label = body.type === "state" ? `journal: ${body.state}` : `journal: ${body.type} record`;
		const bytes = encodeRecord(record);
		await this.#io.append(this.#handle, this.path, bytes, durable, label);
		this.view.validBytes += bytes.length;
		applyRecord(this.view, record);
	}
}
