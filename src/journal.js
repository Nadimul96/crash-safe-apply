import { JOURNAL_FORMAT, ORIGINALS_DIR, RESERVED_PREFIX } from "./constants.js";
import { crc32Hex } from "./crc32.js";
import { fail } from "./errors.js";
import { ancestorsOf, assertDistinctPaths, checkRelativePath } from "./paths.js";
import { SHA256_HEX, schema } from "./validate.js";

/** @import { Fingerprint, FileStatus, JournalState } from "./types.js" */

/**
 * The journal is an append-only log, one record per line:
 *
 *     <crc32 of json, 8 hex> <json>\n
 *
 * The first record ("prepared") describes the whole change. Later records move
 * the journal through the state machine below, or note per-file progress.
 * A torn final append fails its checksum, and the log ends at the first record
 * that does not verify.
 */

/**
 * Legal journal-level transitions. A self-transition records a resumed run.
 * @type {Readonly<Record<JournalState, readonly JournalState[]>>}
 */
export const TRANSITIONS = Object.freeze({
	prepared: ["applying", "restoring"],
	applying: ["applying", "applied", "incomplete", "restoring"],
	applied: ["complete", "incomplete", "restoring"],
	complete: ["restoring"],
	incomplete: ["applying", "restoring"],
	restoring: ["restoring", "restored"],
	restored: [],
});

const STATES = /** @type {JournalState[]} */ (Object.keys(TRANSITIONS));
/** @type {FileStatus[]} */
const FILE_STATUSES = ["pending", "applying", "applied", "restoring", "restored"];
const DIR_STATUSES = /** @type {const} */ (["created", "removed", "kept"]);
const SHORT_ID = /^[0-9a-f]{16}$/;
const DECIMAL = /^\d{1,24}$/;
const MAX_RECORD_FILES = 100_000;
const v = schema("INVALID_JOURNAL");

/**
 * @typedef {object} JournalFile
 * @property {number} index
 * @property {string} path
 * @property {"create" | "replace"} action
 * @property {string} sha256          content apply installs
 * @property {number} size
 * @property {number} mode
 * @property {Fingerprint | null} original  file that was there before (null for creates)
 * @property {string | null} backup   copy of the original, relative to the journal directory
 * @property {string} temp            basename of the temp file staged next to the destination
 */

/**
 * @typedef {object} PreparedRecord
 * @property {number} seq
 * @property {string} at
 * @property {"prepared"} type
 * @property {string} format
 * @property {{ id: string, digest: string, name: string | null }} bundle
 * @property {string} target
 * @property {string} plan
 * @property {number} generation
 * @property {Omit<JournalFile, "index">[]} files
 * @property {string[]} directories   created by apply, parents first
 * @property {boolean} sync
 */

/**
 * @typedef {{ type: "state", state: JournalState, note?: string, sync: true }
 *   | { type: "file", index: number, status: FileStatus, note?: string }
 *   | { type: "dir", path: string, status: "created" | "removed" | "kept" }
 *   | { type: "error", message: string }} RecordBody
 */

/** @typedef {RecordBody & { seq: number, at: string }} LaterRecord */

/**
 * @typedef {object} JournalView
 * @property {PreparedRecord} header
 * @property {JournalState} state
 * @property {Array<JournalFile & { status: FileStatus }>} files
 * @property {number} lastSeq
 * @property {string} updatedAt
 * @property {number} records
 * @property {number} validBytes      length of the verified prefix
 * @property {number} discardedBytes  bytes after it (a torn or corrupt tail)
 */

/**
 * @param {string} bundleId
 * @param {number} generation
 * @param {number} index
 */
export function tempName(bundleId, generation, index) {
	return `${RESERVED_PREFIX}-${bundleId}-${generation}-${index}.tmp`;
}

/** @param {object} record */
export function encodeRecord(record) {
	const json = JSON.stringify(record);
	return Buffer.from(`${crc32Hex(json)} ${json}\n`, "utf8");
}

/**
 * @param {Buffer} bytes
 * @returns {JournalView}
 */
export function decodeJournal(bytes) {
	/** @type {unknown[]} */
	const records = [];
	let offset = 0;
	while (offset < bytes.length) {
		const newline = bytes.indexOf(0x0a, offset);
		const record = newline === -1 ? null : parseLine(bytes.toString("utf8", offset, newline));
		if (record === null) break;
		records.push(record);
		offset = newline + 1;
	}
	const [first, ...rest] = records;
	if (first === undefined) fail("INVALID_JOURNAL", "Journal has no valid prepared record");
	const view = createView(parsePrepared(first), offset, bytes.length - offset);
	for (const record of rest) applyRecord(view, parseLater(record, view));
	return view;
}

/**
 * @param {string} line
 * @returns {unknown}
 */
function parseLine(line) {
	const separator = line.indexOf(" ");
	if (separator !== 8) return null;
	const json = line.slice(9);
	if (crc32Hex(json) !== line.slice(0, 8)) return null;
	try {
		return JSON.parse(json);
	} catch {
		return null;
	}
}

/**
 * @param {PreparedRecord} header
 * @param {number} validBytes
 * @param {number} discardedBytes
 * @returns {JournalView}
 */
export function createView(header, validBytes, discardedBytes) {
	return {
		header,
		state: "prepared",
		files: header.files.map((file, index) => ({
			...file,
			index,
			status: "pending",
		})),
		lastSeq: header.seq,
		updatedAt: header.at,
		records: 1,
		validBytes,
		discardedBytes,
	};
}

/**
 * Folds one already-validated record into the view.
 * @param {JournalView} view
 * @param {LaterRecord} record
 */
export function applyRecord(view, record) {
	if (record.type === "state") view.state = record.state;
	if (record.type === "file") {
		const file = view.files[record.index];
		if (file) file.status = record.status;
	}
	view.lastSeq = record.seq;
	view.updatedAt = record.at;
	view.records += 1;
}

/**
 * @param {JournalState} from
 * @param {JournalState} to
 */
export function canTransition(from, to) {
	return TRANSITIONS[from].includes(to);
}

/**
 * @param {unknown} value
 * @returns {PreparedRecord}
 */
function parsePrepared(value) {
	const record = v.object(value, "prepared record", [
		"seq",
		"at",
		"type",
		"format",
		"bundle",
		"target",
		"plan",
		"generation",
		"files",
		"directories",
		"sync",
	]);
	v.oneOf(record.type, "first record type", ["prepared"]);
	v.oneOf(record.format, "journal format", [JOURNAL_FORMAT]);
	if (record.seq !== 1) fail("INVALID_JOURNAL", "The prepared record must have seq 1");
	const bundleRecord = v.object(record.bundle, "bundle", ["id", "digest", "name"]);
	const bundle = {
		id: v.string(bundleRecord.id, "bundle.id", SHORT_ID),
		digest: v.string(bundleRecord.digest, "bundle.digest", SHA256_HEX),
		name: bundleRecord.name === null ? null : v.string(bundleRecord.name, "bundle.name"),
	};
	const generation = v.integer(record.generation, "generation", 1, 999_999);
	const files = v
		.array(record.files, "files", MAX_RECORD_FILES)
		.map((file, index) => parseJournalFile(file, index, bundle.id, generation));
	assertDistinctPaths(files.map((file) => file.path));
	const directories = v.array(record.directories, "directories", MAX_RECORD_FILES).map((dir) => {
		const path = checkRelativePath(dir);
		const isAncestor = files.some((file) => ancestorsOf(file.path).includes(path));
		if (!isAncestor) fail("INVALID_JOURNAL", `Directory ${path} is not a parent of any file`);
		return path;
	});
	return {
		seq: 1,
		at: v.string(record.at, "at"),
		type: "prepared",
		format: JOURNAL_FORMAT,
		bundle,
		target: v.string(record.target, "target"),
		plan: v.string(record.plan, "plan", SHORT_ID),
		generation,
		files,
		directories,
		sync: true,
	};
}

/**
 * Re-validates every path and name, so an edited journal cannot point a
 * rollback outside the target or at someone else's file.
 * @param {unknown} value
 * @param {number} index
 * @param {string} bundleId
 * @param {number} generation
 * @returns {Omit<JournalFile, "index">}
 */
function parseJournalFile(value, index, bundleId, generation) {
	const where = `files[${index}]`;
	const record = v.object(value, where, [
		"path",
		"action",
		"sha256",
		"size",
		"mode",
		"original",
		"backup",
		"temp",
	]);
	const action = v.oneOf(
		record.action,
		`${where}.action`,
		/** @type {const} */ (["create", "replace"]),
	);
	const original =
		record.original === null ? null : parseFingerprint(record.original, `${where}.original`);
	if ((action === "replace") !== (original !== null)) {
		fail("INVALID_JOURNAL", `${where}: only replacements have an original`);
	}
	const backup = original ? `${ORIGINALS_DIR}/${index}` : null;
	if (record.backup !== backup) fail("INVALID_JOURNAL", `${where}.backup must be ${backup}`);
	const temp = tempName(bundleId, generation, index);
	if (record.temp !== temp) fail("INVALID_JOURNAL", `${where}.temp must be ${temp}`);
	return {
		path: checkRelativePath(record.path),
		action,
		sha256: v.string(record.sha256, `${where}.sha256`, SHA256_HEX),
		size: v.integer(record.size, `${where}.size`, 0, Number.MAX_SAFE_INTEGER),
		mode: v.integer(record.mode, `${where}.mode`, 0, 0o777),
		original,
		backup,
		temp,
	};
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {Fingerprint}
 */
function parseFingerprint(value, where) {
	const record = v.object(value, where, ["sha256", "size", "mode", "dev", "ino"]);
	return {
		sha256: v.string(record.sha256, `${where}.sha256`, SHA256_HEX),
		size: v.integer(record.size, `${where}.size`, 0, Number.MAX_SAFE_INTEGER),
		mode: v.integer(record.mode, `${where}.mode`, 0, 0o777),
		dev: v.string(record.dev, `${where}.dev`, DECIMAL),
		ino: v.string(record.ino, `${where}.ino`, DECIMAL),
	};
}

/**
 * @param {unknown} value
 * @param {JournalView} view
 * @returns {LaterRecord}
 */
function parseLater(value, view) {
	const base = v.object(
		value,
		"record",
		["seq", "at", "type"],
		["state", "note", "sync", "index", "status", "path", "message"],
	);
	const seq = v.integer(base.seq, "record seq", view.lastSeq + 1, view.lastSeq + 1);
	const at = v.string(base.at, `record ${seq} at`);
	const where = `record ${seq}`;
	const note = base.note === undefined ? {} : { note: v.string(base.note, `${where} note`) };
	switch (base.type) {
		case "state": {
			const state = v.oneOf(base.state, `${where} state`, STATES);
			if (!canTransition(view.state, state)) {
				fail("INVALID_JOURNAL", `${where}: illegal transition ${view.state} -> ${state}`);
			}
			return { seq, at, type: "state", state, ...note, sync: true };
		}
		case "file": {
			const index = v.integer(base.index, `${where} index`, 0, view.files.length - 1);
			const status = v.oneOf(base.status, `${where} status`, FILE_STATUSES);
			return { seq, at, type: "file", index, status, ...note };
		}
		case "dir": {
			const path = checkRelativePath(base.path);
			if (!view.header.directories.includes(path)) {
				fail("INVALID_JOURNAL", `${where}: ${path} is not a planned directory`);
			}
			return {
				seq,
				at,
				type: "dir",
				path,
				status: v.oneOf(base.status, `${where} status`, DIR_STATUSES),
			};
		}
		case "error":
			return {
				seq,
				at,
				type: "error",
				message: v.string(base.message, `${where} message`),
			};
		default:
			return fail("INVALID_JOURNAL", `${where} has unknown type ${JSON.stringify(base.type)}`);
	}
}
