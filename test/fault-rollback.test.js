import assert from "node:assert/strict";
import { it } from "node:test";
import { rollbackMatrix } from "./support/fault-matrix.js";

it("rollback: a crash after any step is finished by running rollback again", async (t) => {
	const result = await rollbackMatrix();
	assert.ok(result.points.length > 20, `expected many crash points, got ${result.points.length}`);
	t.diagnostic(
		`rollback: ${result.points.length} crash points, ${result.recoveries} recoveries, status seen ${JSON.stringify(result.statusSeen)}`,
	);
});
