import { fail } from "./errors.js";

/** @import { ErrorCode } from "./errors.js" */

/**
 * Field readers for untrusted JSON (manifests and journals). Each check is one
 * small function with its own message, instead of one long boolean condition.
 * @param {ErrorCode} code
 */
export function schema(code) {
	return {
		/**
		 * @param {unknown} value
		 * @param {string} where
		 * @param {readonly string[]} required
		 * @param {readonly string[]} [optional]
		 * @returns {Record<string, unknown>}
		 */
		object(value, where, required, optional = []) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				fail(code, `${where} must be an object`);
			}
			const record = /** @type {Record<string, unknown>} */ (value);
			for (const key of Object.keys(record)) {
				if (!required.includes(key) && !optional.includes(key)) {
					fail(code, `${where} has an unknown field "${key}"`);
				}
			}
			for (const key of required) {
				if (!(key in record)) fail(code, `${where} is missing "${key}"`);
			}
			return record;
		},

		/**
		 * @param {unknown} value
		 * @param {string} where
		 * @param {RegExp} [pattern]
		 * @returns {string}
		 */
		string(value, where, pattern) {
			if (typeof value !== "string") fail(code, `${where} must be a string`);
			if (pattern && !pattern.test(value)) {
				fail(code, `${where} has an invalid value ${JSON.stringify(value)}`);
			}
			return value;
		},

		/**
		 * @param {unknown} value
		 * @param {string} where
		 * @param {number} min
		 * @param {number} max
		 * @returns {number}
		 */
		integer(value, where, min, max) {
			if (!Number.isSafeInteger(value)) fail(code, `${where} must be an integer`);
			const number = /** @type {number} */ (value);
			if (number < min || number > max) {
				fail(code, `${where} must be between ${min} and ${max}`);
			}
			return number;
		},

		/**
		 * @template {string} T
		 * @param {unknown} value
		 * @param {string} where
		 * @param {readonly T[]} options
		 * @returns {T}
		 */
		oneOf(value, where, options) {
			if (!options.includes(/** @type {T} */ (value))) {
				fail(code, `${where} must be one of ${options.join(", ")}`);
			}
			return /** @type {T} */ (value);
		},

		/**
		 * @param {unknown} value
		 * @param {string} where
		 * @param {number} maxLength
		 * @returns {unknown[]}
		 */
		array(value, where, maxLength) {
			if (!Array.isArray(value)) fail(code, `${where} must be an array`);
			if (value.length > maxLength) {
				fail(code, `${where} has more than ${maxLength} entries`);
			}
			return value;
		},
	};
}

export const SHA256_HEX = /^[0-9a-f]{64}$/;
