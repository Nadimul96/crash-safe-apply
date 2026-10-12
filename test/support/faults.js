/** @import { FaultHook, FaultPoint } from "../../src/types.js" */

/** Thrown by a fault hook to model the process dying right after a step. */
export class SimulatedCrash extends Error {
	/** @param {FaultPoint} point */
	constructor(point) {
		super(`simulated crash after step ${point.seq}: ${point.op} ${point.path} (${point.step})`);
		this.name = "SimulatedCrash";
		this.point = point;
	}
}

/**
 * Crashes at the first step that matches (a step number or a predicate).
 * @param {number | ((point: FaultPoint) => boolean)} when
 * @returns {FaultHook}
 */
export function crashAt(when) {
	const matches = typeof when === "number" ? (/** @type {FaultPoint} */ p) => p.seq === when : when;
	return (point) => {
		if (matches(point)) throw new SimulatedCrash(point);
	};
}

/**
 * Records every step without interfering.
 * @param {FaultPoint[]} into
 * @returns {FaultHook}
 */
export function record(into) {
	return (point) => {
		into.push(point);
	};
}
