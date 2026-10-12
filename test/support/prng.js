/**
 * mulberry32: a tiny seeded PRNG, so fuzz failures reproduce from their seed.
 * @param {number} seed
 */
export function prng(seed) {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		next,
		/** @param {number} n integer in [0, n) */
		int: (n) => Math.floor(next() * n),
		/** @template T @param {readonly T[]} items @returns {T} */
		pick: (items) => /** @type {T} */ (items[Math.floor(next() * items.length)]),
	};
}
