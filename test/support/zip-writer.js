import { crc32 } from "../../src/crc32.js";

/**
 * @typedef {object} ZipEntry
 * @property {string} name
 * @property {Buffer} [data]
 * @property {number} [unixMode]   full st_mode, e.g. 0o100644 or 0o120777 for a symlink
 * @property {number} [method]     defaults to 0 (stored)
 * @property {number} [flags]
 * @property {number} [crc]        override the computed CRC-32
 */

/**
 * Minimal writer for test archives: local headers and data, then the central
 * directory, then the end record. Knobs exist only to build invalid archives.
 * @param {ZipEntry[]} entries
 * @param {{ comment?: string }} [options]
 * @returns {Buffer}
 */
export function buildZip(entries, { comment = "" } = {}) {
	/** @type {Buffer[]} */
	const locals = [];
	/** @type {Buffer[]} */
	const centrals = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const data = entry.data ?? Buffer.alloc(0);
		const crc = entry.crc ?? crc32(data);
		const method = entry.method ?? 0;
		const flags = entry.flags ?? 0x0800;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(local, name, data);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE((3 << 8) | 20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(flags, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(name.length, 28);
		const defaultMode = entry.name.endsWith("/") ? 0o040755 : 0o100644;
		central.writeUInt32LE(((entry.unixMode ?? defaultMode) << 16) >>> 0, 38);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);
		offset += 30 + name.length + data.length;
	}
	const centralBytes = Buffer.concat(centrals);
	const commentBytes = Buffer.from(comment, "utf8");
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralBytes.length, 12);
	end.writeUInt32LE(offset, 16);
	end.writeUInt16LE(commentBytes.length, 20);
	return Buffer.concat([...locals, centralBytes, end, commentBytes]);
}
