import assert from "node:assert/strict";
import { it } from "node:test";
import { CrashSafeError } from "../src/errors.js";
import { checkRelativePath } from "../src/paths.js";
import { readStoredZip } from "../src/zip.js";
import { prng } from "./support/prng.js";
import { buildZip } from "./support/zip-writer.js";

const CASES = 4000;
const SEED = 0x5eed_c5a;
const LIMITS = { maxEntries: 64, maxFileBytes: 4096, maxTotalBytes: 16_384 };
const HOSTILE_NAMES = [
	"../escape",
	"a/../../b",
	"/abs",
	"a//b",
	"C:\\x",
	".git/config",
	"ok/./x",
	"a\u0000b",
	".crash-safe-apply/lock",
];

/**
 * Builds a valid archive from random entries, then damages it with one or
 * more random mutations. The reader must either reject it with a typed error
 * or return entries that satisfy every invariant; never crash, hang or throw
 * a RangeError from an out-of-bounds read.
 */
it(`survives ${CASES} mutated archives (seed ${SEED.toString(16)})`, () => {
	const random = prng(SEED);
	const tally = { accepted: 0, rejected: 0 };
	for (let index = 0; index < CASES; index += 1) {
		const bytes = mutate(randomArchive(random), random);
		try {
			const result = readStoredZip(bytes, LIMITS);
			for (const name of [...result.files.keys(), ...result.directories]) checkRelativePath(name);
			const total = [...result.files.values()].reduce((sum, data) => sum + data.length, 0);
			assert.ok(total <= LIMITS.maxTotalBytes);
			tally.accepted += 1;
		} catch (error) {
			if (
				!(error instanceof CrashSafeError) ||
				!["INVALID_ZIP", "UNSAFE_PATH"].includes(error.code)
			) {
				assert.fail(
					`case ${index}: unexpected ${error instanceof Error ? error.stack : String(error)}`,
				);
			}
			tally.rejected += 1;
		}
	}
	assert.equal(tally.accepted + tally.rejected, CASES);
	assert.ok(tally.rejected > CASES / 2, "most mutations must be caught");
});

/** @param {ReturnType<typeof prng>} random */
function randomArchive(random) {
	const count = 1 + random.int(6);
	const entries = [];
	for (let i = 0; i < count; i += 1) {
		const hostile = random.next() < 0.1;
		const name = hostile ? random.pick(HOSTILE_NAMES) : `dir${random.int(3)}/file${i}.txt`;
		const size = random.next() < 0.05 ? 5000 : random.int(200);
		const data = Buffer.alloc(size);
		for (let b = 0; b < size; b += 1) data[b] = random.int(256);
		entries.push({ name, data });
	}
	return buildZip(entries, { comment: random.next() < 0.2 ? "comment" : "" });
}

/**
 * @param {Buffer} input
 * @param {ReturnType<typeof prng>} random
 */
function mutate(input, random) {
	let bytes = Buffer.from(input);
	const rounds = 1 + random.int(3);
	for (let round = 0; round < rounds; round += 1) {
		switch (random.int(7)) {
			case 0:
				bytes = bytes.subarray(0, random.int(bytes.length + 1));
				break;
			case 1:
				if (bytes.length > 0) bytes[random.int(bytes.length)] = random.int(256);
				break;
			case 2: {
				const at = random.int(Math.max(1, bytes.length - 4));
				if (at + 4 <= bytes.length)
					bytes.writeUInt32LE(random.next() < 0.5 ? 0xffffffff : random.int(2 ** 31), at);
				break;
			}
			case 3:
				bytes = Buffer.concat([bytes, Buffer.alloc(random.int(32), random.int(256))]);
				break;
			case 4: {
				const at = random.int(bytes.length + 1);
				bytes = Buffer.concat([
					bytes.subarray(0, at),
					Buffer.from([random.int(256)]),
					bytes.subarray(at),
				]);
				break;
			}
			case 5:
				break;
			default:
				corruptHeaderField(bytes, random);
				break;
		}
	}
	return bytes;
}

// Size, offset, name-length and flag fields of a random central directory entry.
const CENTRAL_FIELDS = [
	[8, 2],
	[10, 2],
	[16, 4],
	[20, 4],
	[24, 4],
	[28, 2],
	[30, 2],
	[32, 2],
	[42, 4],
];

/**
 * @param {Buffer} bytes
 * @param {ReturnType<typeof prng>} random
 */
function corruptHeaderField(bytes, random) {
	if (bytes.length < 22) return;
	const centralOffset = bytes.readUInt32LE(bytes.length - 22 + 16);
	const centralSize = bytes.readUInt32LE(bytes.length - 22 + 12);
	if (centralSize < 46 || centralOffset + 46 > bytes.length) return;
	const [offset, width] = random.pick(CENTRAL_FIELDS);
	const at = centralOffset + /** @type {number} */ (offset);
	const value = random.pick([0, 1, 0xffff, random.int(65536), random.int(2 ** 31)]);
	if (width === 2) bytes.writeUInt16LE(value & 0xffff, at);
	else bytes.writeUInt32LE(value >>> 0, at);
}
