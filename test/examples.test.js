import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { apply, preview, rollback } from "../src/index.js";
import { snapshot, tempDir } from "./support/tree.js";

const examples = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples");

it("the demo bundle in examples/ applies to the demo target and rolls back exactly", async (t) => {
	const target = path.join(await tempDir(t), "demo-service");
	await fs.cp(path.join(examples, "demo-target"), target, { recursive: true });
	const bundle = path.join(examples, "demo-bundle");
	const original = await snapshot(target);
	const plan = await preview({ bundle, target });
	assert.deepEqual(plan.summary, {
		create: 3,
		replace: 1,
		unchanged: 1,
		bytes: plan.summary.bytes,
	});
	await apply({ bundle, target, plan: plan.id });
	assert.equal((await fs.stat(path.join(target, "bin/healthcheck.sh"))).mode & 0o777, 0o755);
	await rollback({ bundle, target });
	assert.deepEqual(await snapshot(target), original);
});
