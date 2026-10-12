import assert from "node:assert/strict";
import { it } from "node:test";
import { applyMatrix } from "./support/fault-matrix.js";

it("apply: a crash after any step leaves a state that rollback restores and re-apply finishes", async (t) => {
	const result = await applyMatrix();
	assert.ok(result.points.length > 50, `expected many crash points, got ${result.points.length}`);
	/** @type {Set<string>} */
	const ops = new Set(result.points.map((p) => p.op));
	for (const op of ["fsync", "fsync-dir", "rename", "link", "write-partial", "mkdir", "unlink"])
		assert.ok(ops.has(op), `no ${op} step`);
	t.diagnostic(
		`apply: ${result.points.length} crash points, ${result.recoveries} recoveries, status seen ${JSON.stringify(result.statusSeen)}`,
	);
});
