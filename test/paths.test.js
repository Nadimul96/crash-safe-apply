import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ancestorsOf, assertDistinctPaths, checkRelativePath } from "../src/paths.js";

const rejects = (/** @type {unknown} */ value, /** @type {RegExp} */ reason) =>
	assert.throws(() => checkRelativePath(value), { code: "UNSAFE_PATH", message: reason });

describe("checkRelativePath", () => {
	it("accepts ordinary nested paths", () => {
		for (const path of [
			"a",
			"config/app.toml",
			"deep/er/still/file.txt",
			".gitignore",
			"café/menu.md",
		]) {
			assert.equal(checkRelativePath(path), path);
		}
	});

	it("rejects traversal and absolute paths", () => {
		rejects("../etc/passwd", /"\.\." segment/);
		rejects("a/../../b", /"\.\." segment/);
		rejects("a/./b", /"\." segment/);
		rejects("/etc/passwd", /absolute/);
	});

	it("rejects empty segments, separators and control characters", () => {
		rejects("", /non-empty/);
		rejects("a//b", /empty segment/);
		rejects("a/", /empty segment/);
		rejects("a\\b", /backslash/);
		rejects("c:/windows", /colon/);
		rejects("a\u0000b", /control/);
		rejects("line\nbreak", /control/);
		rejects(42, /non-empty string/);
	});

	it("rejects .git and our reserved state names, in any case", () => {
		rejects(".git/hooks/pre-commit", /\.git/);
		rejects("sub/.GIT/config", /\.git/);
		rejects(".crash-safe-apply/lock", /reserved/);
		rejects("x/.Crash-Safe-Apply-temp.tmp", /reserved/);
	});

	it("rejects non-NFC Unicode and oversized paths", () => {
		rejects("cafe\u0301", /NFC/);
		rejects(`${"a".repeat(256)}`, /segment longer/);
		rejects(Array.from({ length: 33 }, () => "d").join("/"), /deeper/);
		rejects(Array.from({ length: 10 }, () => "x".repeat(120)).join("/"), /longer than 1024/);
	});
});

describe("assertDistinctPaths", () => {
	it("accepts distinct paths", () => {
		assert.doesNotThrow(() => assertDistinctPaths(["a/b", "a/c", "b"]));
	});

	it("rejects duplicates and case-insensitive collisions", () => {
		assert.throws(() => assertDistinctPaths(["a", "a"]), /listed twice/);
		assert.throws(() => assertDistinctPaths(["README.md", "readme.md"]), /collides/);
	});

	it("rejects a name used as both file and directory", () => {
		assert.throws(() => assertDistinctPaths(["config", "config/app.toml"]), /also a file/);
	});
});

it("ancestorsOf lists parents, shallowest first", () => {
	assert.deepEqual(ancestorsOf("a/b/c"), ["a", "a/b"]);
	assert.deepEqual(ancestorsOf("top"), []);
});
