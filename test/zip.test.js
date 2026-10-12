import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { readStoredZip } from "../src/zip.js";
import { tempDir, writeTree } from "./support/tree.js";
import { buildZip } from "./support/zip-writer.js";

const LIMITS = { maxEntries: 100, maxFileBytes: 1024, maxTotalBytes: 4096 };
const hello = Buffer.from("hello\n");

/** @param {Buffer} bytes @param {RegExp} reason */
const invalid = (bytes, reason) =>
	assert.throws(() => readStoredZip(bytes, LIMITS), { code: "INVALID_ZIP", message: reason });

describe("readStoredZip", () => {
	it("reads stored entries and directory entries", () => {
		const zip = buildZip([
			{ name: "files/" },
			{ name: "files/a.txt", data: hello },
			{ name: "b.bin", data: Buffer.from([0, 1, 2]) },
		]);
		const result = readStoredZip(zip, LIMITS);
		assert.deepEqual([...result.files.keys()], ["files/a.txt", "b.bin"]);
		assert.deepEqual(result.files.get("files/a.txt"), hello);
		assert.deepEqual(result.directories, ["files"]);
	});

	it("accepts an archive comment", () => {
		const zip = buildZip([{ name: "a", data: hello }], { comment: "made by a test" });
		assert.equal(readStoredZip(zip, LIMITS).files.size, 1);
	});

	it("reads archives made by Info-ZIP `zip -0`", async (t) => {
		try {
			execFileSync("zip", ["-v"], { stdio: "ignore" });
		} catch {
			t.skip("zip is not installed");
			return;
		}
		const dir = await tempDir(t);
		await writeTree(dir, { "manifest.json": "{}", "files/config/app.toml": "port = 1\n" });
		execFileSync("zip", ["-0", "-r", "-X", "-q", "bundle.zip", "manifest.json", "files"], {
			cwd: dir,
		});
		const result = readStoredZip(await fs.readFile(path.join(dir, "bundle.zip")), LIMITS);
		assert.deepEqual([...result.files.keys()].sort(), ["files/config/app.toml", "manifest.json"]);
	});

	it("rejects compressed, encrypted and streamed entries", () => {
		invalid(buildZip([{ name: "a", data: hello, method: 8 }]), /only stored/);
		invalid(buildZip([{ name: "a", data: hello, flags: 0x0001 }]), /encrypted, streamed/);
		invalid(buildZip([{ name: "a", data: hello, flags: 0x0008 }]), /encrypted, streamed/);
	});

	it("rejects a CRC mismatch", () => {
		invalid(buildZip([{ name: "a", data: hello, crc: 0x12345678 }]), /CRC-32 mismatch/);
	});

	it("rejects symlinks and special files", () => {
		invalid(
			buildZip([{ name: "link", data: Buffer.from("/etc/passwd"), unixMode: 0o120777 }]),
			/symlink/,
		);
		invalid(buildZip([{ name: "fifo", unixMode: 0o010644 }]), /symlink/);
	});

	it("rejects zip-slip and absolute names", () => {
		assert.throws(() => readStoredZip(buildZip([{ name: "../evil", data: hello }]), LIMITS), {
			code: "UNSAFE_PATH",
		});
		assert.throws(() => readStoredZip(buildZip([{ name: "/etc/cron.d/x", data: hello }]), LIMITS), {
			code: "UNSAFE_PATH",
		});
		assert.throws(() => readStoredZip(buildZip([{ name: "files/../../x", data: hello }]), LIMITS), {
			code: "UNSAFE_PATH",
		});
	});

	it("rejects duplicate entries", () => {
		invalid(
			buildZip([
				{ name: "a", data: hello },
				{ name: "a", data: hello },
			]),
			/duplicate/,
		);
	});

	it("rejects truncation and trailing bytes", () => {
		const zip = buildZip([{ name: "a", data: hello }]);
		invalid(zip.subarray(0, zip.length - 1), /end-of-central-directory/);
		invalid(zip.subarray(0, 10), /end-of-central-directory/);
		invalid(Buffer.concat([zip, Buffer.from("x")]), /end-of-central-directory/);
		invalid(Buffer.alloc(0), /end-of-central-directory/);
	});

	it("rejects bytes hidden between entries", () => {
		const zip = buildZip([{ name: "a", data: hello }]);
		const end = zip.length - 22;
		const centralOffset = zip.readUInt32LE(end + 16);
		const padded = Buffer.concat([
			zip.subarray(0, centralOffset),
			Buffer.from("HIDDEN"),
			zip.subarray(centralOffset),
		]);
		padded.writeUInt32LE(centralOffset + 6, padded.length - 22 + 16);
		invalid(padded, /unlisted bytes/);
	});

	it("rejects two central entries that point at the same data", () => {
		const one = buildZip([
			{ name: "a", data: hello },
			{ name: "b", data: hello },
		]);
		const centralOffset = one.readUInt32LE(one.length - 22 + 16);
		const second = centralOffset + 46 + 1;
		one.writeUInt32LE(0, second + 42);
		invalid(one, /disagree|overlap/);
	});

	it("enforces entry, file-size and total-size limits", () => {
		const big = Buffer.alloc(2000, 1);
		invalid(buildZip([{ name: "big", data: big }]), /larger than the 1024-byte limit/);
		const many = Array.from({ length: 5 }, (_, i) => ({
			name: `f${i}`,
			data: Buffer.alloc(1000, i),
		}));
		invalid(buildZip(many), /total limit/);
		const lots = Array.from({ length: 101 }, (_, i) => ({ name: `e${i}` }));
		invalid(buildZip(lots), /more than 100 entries/);
	});

	it("rejects ZIP64 markers", () => {
		const zip = buildZip([{ name: "a", data: hello }]);
		zip.writeUInt16LE(0xffff, zip.length - 22 + 8);
		zip.writeUInt16LE(0xffff, zip.length - 22 + 10);
		invalid(zip, /ZIP64/);
	});
});
