import assert from "node:assert/strict";
import { it } from "node:test";
import { doubleFaultMatrix } from "./support/fault-matrix.js";

it("double faults: crashing during recovery still converges on the third run", async (t) => {
	const result = await doubleFaultMatrix(3);
	assert.ok(result.points.length > 50, `expected many crash points, got ${result.points.length}`);
	t.diagnostic(
		`double fault: ${result.points.length} crash points, ${result.recoveries} recoveries, status seen ${JSON.stringify(result.statusSeen)}`,
	);
});
