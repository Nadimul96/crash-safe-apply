import { crc32 } from "./crc32.js";
import { CrashSafeError, fail } from "./errors.js";
import { checkRelativePath } from "./paths.js";

const SIGNATURE = { end: 0x06054b50, central: 0x02014b50, local: 0x04034b50 };
const SIZE = { end: 22, central: 46, local: 30 };
const MAX_COMMENT = 0xffff;
const FLAG_UTF8_NAMES = 0x0800;
const METHOD_STORED = 0;
const HOST_UNIX = 3;
const HOST_MACOS = 19;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const DOS_DIRECTORY_BIT = 0x10;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * @typedef {object} ZipLimits
 * @property {number} maxEntries
 * @property {number} maxFileBytes
 * @property {number} maxTotalBytes
 */

/**
 * @typedef {object} StoredZip
 * @property {Map<string, Buffer>} files   regular-file entries by path
 * @property {string[]} directories        explicit directory entries, without the trailing slash
 */

/**
 * @typedef {object} CentralEntry
 * @property {number} at
 * @property {number} next
 * @property {number} host
 * @property {number} flags
 * @property {number} crc
 * @property {number} size
 * @property {Buffer} nameBytes
 * @property {number} external
 * @property {number} localOffset
 */

/**
 * Reads a ZIP whose entries are all stored (uncompressed). Nothing touches the
 * filesystem: every header is cross-checked against its twin, every byte of the
 * archive must belong to exactly one entry, and every CRC-32 is verified.
 * @param {Buffer} bytes
 * @param {ZipLimits} limits
 * @returns {StoredZip}
 */
export function readStoredZip(bytes, limits) {
	const view = new ByteView(bytes);
	const end = findEndRecord(view);
	const { count, centralOffset } = readEndRecord(view, end, limits);
	/** @type {Map<string, Buffer>} */
	const files = new Map();
	/** @type {string[]} */
	const directories = [];
	/** @type {Array<[number, number]>} */
	const regions = [];
	let total = 0;
	let at = centralOffset;
	for (let index = 0; index < count; index += 1) {
		const entry = readCentralEntry(view, at, end);
		const { path, isDirectory } = entryPath(entry);
		if (files.has(path) || directories.includes(path)) {
			invalid(`duplicate entry "${path}"`);
		}
		const { data, regionEnd } = readLocalEntry(view, entry, centralOffset, limits);
		if (isDirectory) {
			if (data.length !== 0) invalid(`directory entry "${path}" has data`);
			directories.push(path);
		} else {
			total += data.length;
			if (total > limits.maxTotalBytes) {
				invalid(`entries exceed the ${limits.maxTotalBytes}-byte total limit`);
			}
			files.set(path, data);
		}
		regions.push([entry.localOffset, regionEnd]);
		at = entry.next;
	}
	if (at !== end) invalid("central directory size does not match its entries");
	assertTiled(regions, centralOffset);
	return { files, directories };
}

/** @param {ByteView} view */
function findEndRecord(view) {
	const last = view.length - SIZE.end;
	const first = Math.max(0, last - MAX_COMMENT);
	for (let at = last; at >= first; at -= 1) {
		if (view.u32(at) !== SIGNATURE.end) continue;
		if (at + SIZE.end + view.u16(at + 20) === view.length) return at;
	}
	return invalid("end-of-central-directory record not found");
}

/**
 * @param {ByteView} view
 * @param {number} end
 * @param {ZipLimits} limits
 */
function readEndRecord(view, end, limits) {
	const diskNumber = view.u16(end + 4);
	const centralDisk = view.u16(end + 6);
	const countOnDisk = view.u16(end + 8);
	const count = view.u16(end + 10);
	const centralSize = view.u32(end + 12);
	const centralOffset = view.u32(end + 16);
	if (diskNumber !== 0 || centralDisk !== 0 || countOnDisk !== count) {
		invalid("split or multi-disk archives are not supported");
	}
	if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
		invalid("ZIP64 archives are not supported");
	}
	if (count === 0) invalid("archive is empty");
	if (count > limits.maxEntries) invalid(`more than ${limits.maxEntries} entries`);
	if (centralOffset + centralSize !== end) {
		invalid("central directory does not end where the end record begins");
	}
	return { count, centralOffset };
}

/**
 * @param {ByteView} view
 * @param {number} at
 * @param {number} end
 * @returns {CentralEntry}
 */
function readCentralEntry(view, at, end) {
	if (at + SIZE.central > end || view.u32(at) !== SIGNATURE.central) {
		invalid(`bad central directory header at offset ${at}`);
	}
	const flags = view.u16(at + 8);
	const method = view.u16(at + 10);
	const compressed = view.u32(at + 20);
	const size = view.u32(at + 24);
	const nameLength = view.u16(at + 28);
	const next = at + SIZE.central + nameLength + view.u16(at + 30) + view.u16(at + 32);
	if (next > end) invalid(`central directory entry at offset ${at} overruns`);
	if ((flags & ~FLAG_UTF8_NAMES) !== 0) {
		invalid("encrypted, streamed or otherwise flagged entries are not supported");
	}
	if (method !== METHOD_STORED || compressed !== size) {
		invalid("only stored (uncompressed) entries are supported; create the bundle with `zip -0`");
	}
	if (view.u16(at + 34) !== 0) invalid("split archives are not supported");
	if (nameLength === 0) invalid(`entry at offset ${at} has no name`);
	return {
		at,
		next,
		host: view.u8(at + 5),
		flags,
		crc: view.u32(at + 16),
		size,
		nameBytes: view.slice(at + SIZE.central, nameLength),
		external: view.u32(at + 38),
		localOffset: view.u32(at + 42),
	};
}

/**
 * @param {CentralEntry} entry
 * @returns {{ path: string, isDirectory: boolean }}
 */
function entryPath(entry) {
	let name;
	try {
		name = utf8.decode(entry.nameBytes);
	} catch {
		return invalid(`entry at offset ${entry.at} has a name that is not UTF-8`);
	}
	const isDirectory = name.endsWith("/");
	const path = checkRelativePath(isDirectory ? name.slice(0, -1) : name);
	const unixType =
		entry.host === HOST_UNIX || entry.host === HOST_MACOS ? (entry.external >>> 16) & S_IFMT : 0;
	const dosDirectory = (entry.external & DOS_DIRECTORY_BIT) !== 0;
	if (isDirectory) {
		if (unixType !== 0 && unixType !== S_IFDIR) invalid(`"${name}" has a non-directory type`);
	} else if ((unixType !== 0 && unixType !== S_IFREG) || dosDirectory) {
		invalid(`"${name}" is a symlink, device or other special file`);
	}
	return { path, isDirectory };
}

/**
 * @param {ByteView} view
 * @param {CentralEntry} entry
 * @param {number} centralOffset
 * @param {ZipLimits} limits
 */
function readLocalEntry(view, entry, centralOffset, limits) {
	const at = entry.localOffset;
	const label = utf8.decode(entry.nameBytes);
	if (at + SIZE.local > centralOffset || view.u32(at) !== SIGNATURE.local) {
		invalid(`bad local header for "${label}"`);
	}
	if (entry.size > limits.maxFileBytes) {
		invalid(`"${label}" is larger than the ${limits.maxFileBytes}-byte limit`);
	}
	const nameLength = view.u16(at + 26);
	const dataStart = at + SIZE.local + nameLength + view.u16(at + 28);
	const dataEnd = dataStart + entry.size;
	const headersAgree =
		view.u16(at + 6) === entry.flags &&
		view.u16(at + 8) === METHOD_STORED &&
		view.u32(at + 14) === entry.crc &&
		view.u32(at + 18) === entry.size &&
		view.u32(at + 22) === entry.size &&
		nameLength === entry.nameBytes.length &&
		view.slice(at + SIZE.local, nameLength).equals(entry.nameBytes);
	if (!headersAgree) invalid(`local and central headers disagree for "${label}"`);
	if (dataEnd > centralOffset) invalid(`data for "${label}" overruns the central directory`);
	const data = view.slice(dataStart, entry.size);
	if (crc32(data) !== entry.crc) invalid(`CRC-32 mismatch for "${label}"`);
	return { data, regionEnd: dataEnd };
}

/**
 * Entries must cover [0, centralOffset) exactly: no gaps that could hide data,
 * and no overlapping entries that reuse the same bytes.
 * @param {Array<[number, number]>} regions
 * @param {number} centralOffset
 */
function assertTiled(regions, centralOffset) {
	regions.sort((a, b) => a[0] - b[0]);
	let expected = 0;
	for (const [start, finish] of regions) {
		if (start !== expected) invalid("entries overlap or leave unlisted bytes");
		expected = finish;
	}
	if (expected !== centralOffset) invalid("unlisted bytes before the central directory");
}

/**
 * @param {string} reason
 * @returns {never}
 */
function invalid(reason) {
	return fail("INVALID_ZIP", `Invalid ZIP bundle: ${reason}`);
}

/** Bounds-checked little-endian reads, so malformed input fails as INVALID_ZIP rather than RangeError. */
class ByteView {
	/** @param {Buffer} bytes */
	constructor(bytes) {
		this.bytes = bytes;
		this.length = bytes.length;
	}

	/** @param {number} at @param {number} width */
	check(at, width) {
		if (!Number.isInteger(at) || at < 0 || at + width > this.length) {
			throw new CrashSafeError("INVALID_ZIP", "Invalid ZIP bundle: truncated archive");
		}
	}

	/** @param {number} at */
	u8(at) {
		this.check(at, 1);
		return this.bytes.readUInt8(at);
	}

	/** @param {number} at */
	u16(at) {
		this.check(at, 2);
		return this.bytes.readUInt16LE(at);
	}

	/** @param {number} at */
	u32(at) {
		this.check(at, 4);
		return this.bytes.readUInt32LE(at);
	}

	/** @param {number} at @param {number} length */
	slice(at, length) {
		this.check(at, length);
		return this.bytes.subarray(at, at + length);
	}
}
