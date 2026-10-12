import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crc32Hex } from "../src/crc32.js";
import { decodeJournal, encodeRecord, TRANSITIONS, tempName } from "../src/journal.js";

const BUNDLE = { id: "0123456789abcdef", digest: "a".repeat(64), name: "demo" };

/** @returns {any} */
function prepared(overrides = {}) {
	return {
		seq: 1,
		at: "2026-10-12T00:00:00.000Z",
		type: "prepared",
		format: "crash-safe-apply/journal@1",
		bundle: BUNDLE,
		target: "/srv/app",
		plan: "fedcba9876543210",
		generation: 1,
		files: [
			{
				path: "conf/app.toml",
				action: "replace",
				sha256: "b".repeat(64),
				size: 10,
				mode: 0o644,
				original: { sha256: "c".repeat(64), size: 8, mode: 0o644, dev: "16777230", ino: "42" },
				backup: "originals/0",
				temp: tempName(BUNDLE.id, 1, 0),
			},
			{
				path: "conf/new/x.json",
				action: "create",
				sha256: "d".repeat(64),
				size: 2,
				mode: 0o644,
				original: null,
				backup: null,
				temp: tempName(BUNDLE.id, 1, 1),
			},
		],
		directories: ["conf/new"],
		sync: true,
		...overrides,
	};
}

/** @param {object[]} records */
const log = (records) => Buffer.concat(records.map((r) => encodeRecord(r)));
const state = (/** @type {number} */ seq, /** @type {string} */ s) => ({
	seq,
	at: "2026-10-12T00:00:01.000Z",
	type: "state",
	state: s,
	sync: true,
});
const file = (
	/** @type {number} */ seq,
	/** @type {number} */ index,
	/** @type {string} */ status,
) => ({ seq, at: "2026-10-12T00:00:02.000Z", type: "file", index, status });

describe("journal encoding", () => {
	it("round-trips records and folds them into a view", () => {
		const view = decodeJournal(
			log([
				prepared(),
				state(2, "applying"),
				file(3, 0, "applying"),
				file(4, 0, "applied"),
				state(5, "applied"),
			]),
		);
		assert.equal(view.state, "applied");
		assert.deepEqual(
			view.files.map((f) => f.status),
			["applied", "pending"],
		);
		assert.equal(view.records, 5);
		assert.equal(view.discardedBytes, 0);
	});

	it("each line is <crc32> <json>", () => {
		const line = encodeRecord(state(2, "applying")).toString();
		const json = line.slice(9, -1);
		assert.equal(line.slice(0, 8), crc32Hex(json));
		assert.ok(line.endsWith("\n"));
	});

	it("ignores a torn final record and reports how many bytes were dropped", () => {
		const whole = log([prepared(), state(2, "applying")]);
		const tail = encodeRecord(file(3, 0, "applying"));
		for (const cut of [1, 9, tail.length - 1]) {
			const view = decodeJournal(Buffer.concat([whole, tail.subarray(0, cut)]));
			assert.equal(view.state, "applying");
			assert.equal(view.records, 2);
			assert.equal(view.validBytes, whole.length);
			assert.equal(view.discardedBytes, cut);
		}
	});

	it("ends the log at the first record whose checksum fails", () => {
		const records = [prepared(), state(2, "applying"), state(3, "applied")].map((r) =>
			encodeRecord(r),
		);
		const damaged = Buffer.from(/** @type {Buffer} */ (records[1]));
		damaged[20] = damaged[20] === 0x61 ? 0x62 : 0x61;
		const view = decodeJournal(
			Buffer.concat([
				/** @type {Buffer} */ (records[0]),
				damaged,
				/** @type {Buffer} */ (records[2]),
			]),
		);
		assert.equal(view.state, "prepared");
		assert.equal(view.records, 1);
	});

	it("rejects illegal transitions, gaps and unknown records", () => {
		assert.throws(
			() => decodeJournal(log([prepared(), state(2, "complete")])),
			/illegal transition prepared -> complete/,
		);
		assert.throws(
			() => decodeJournal(log([prepared(), state(3, "applying")])),
			/seq must be between 2 and 2/,
		);
		assert.throws(
			() => decodeJournal(log([prepared(), { seq: 2, at: "x", type: "mystery" }])),
			/unknown type/,
		);
		assert.throws(
			() => decodeJournal(log([prepared(), file(2, 7, "applied")])),
			/index must be between/,
		);
	});

	it("rejects a journal whose first record is not a valid prepared record", () => {
		assert.throws(() => decodeJournal(Buffer.alloc(0)), /no valid prepared record/);
		assert.throws(() => decodeJournal(log([state(1, "applying")])), { code: "INVALID_JOURNAL" });
	});

	it("re-validates paths and names, so an edited journal cannot redirect a rollback", () => {
		const evil = prepared();
		evil.files[0] = { ...evil.files[0], path: "../../etc/passwd" };
		assert.throws(() => decodeJournal(log([evil])), { code: "UNSAFE_PATH" });
		const wrongTemp = prepared();
		wrongTemp.files[1] = { ...wrongTemp.files[1], temp: "victim.txt" };
		assert.throws(() => decodeJournal(log([wrongTemp])), /temp must be/);
		const wrongBackup = prepared();
		wrongBackup.files[0] = { ...wrongBackup.files[0], backup: "../../../secret" };
		assert.throws(() => decodeJournal(log([wrongBackup])), /backup must be originals\/0/);
		assert.throws(
			() => decodeJournal(log([prepared({ directories: ["elsewhere"] })])),
			/not a parent of any file/,
		);
	});
});

describe("state machine", () => {
	it("reaches every state from prepared and ends only at restored", () => {
		/** @type {Set<string>} */
		const seen = new Set(["prepared"]);
		const queue = ["prepared"];
		while (queue.length > 0) {
			const from = /** @type {keyof typeof TRANSITIONS} */ (queue.shift());
			for (const to of TRANSITIONS[from]) {
				if (!seen.has(to)) {
					seen.add(to);
					queue.push(to);
				}
			}
		}
		assert.deepEqual([...seen].sort(), Object.keys(TRANSITIONS).sort());
		const terminal = Object.entries(TRANSITIONS)
			.filter(([, next]) => next.length === 0)
			.map(([s]) => s);
		assert.deepEqual(terminal, ["restored"]);
	});

	it("every non-terminal state can still reach restored", () => {
		for (const start of Object.keys(TRANSITIONS)) {
			const seen = new Set([start]);
			const queue = [start];
			while (queue.length > 0) {
				for (const to of TRANSITIONS[/** @type {keyof typeof TRANSITIONS} */ (queue.shift())]) {
					if (!seen.has(to)) {
						seen.add(to);
						queue.push(to);
					}
				}
			}
			assert.ok(seen.has("restored"), `${start} cannot reach restored`);
		}
	});
});
