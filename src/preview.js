import { loadBundle } from "./bundle.js";
import { resolveLimits } from "./constants.js";
import { assertPosix, resolveTargetRoot } from "./fsutil.js";
import { buildPlan } from "./plan.js";

/** @import { Plan, TargetOptions } from "./types.js" */

/**
 * Shows what apply would do. Reads the bundle and the target and writes
 * nothing, not even the state directory.
 * @param {TargetOptions} options
 * @returns {Promise<Plan>}
 */
export async function preview(options) {
	assertPosix();
	const limits = resolveLimits(options.limits);
	const bundle = await loadBundle(options.bundle, limits);
	const target = await resolveTargetRoot(options.target);
	return (await buildPlan(bundle, target, limits)).plan;
}
