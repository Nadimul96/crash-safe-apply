// IEEE 802.3 CRC-32, as used by ZIP. Also checksums each journal record so a
// torn append is detectable.
const TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let bit = 0; bit < 8; bit += 1) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

/**
 * @param {Uint8Array} bytes
 * @returns {number} unsigned 32-bit checksum
 */
export function crc32(bytes) {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc = /** @type {number} */ (TABLE[(crc ^ byte) & 0xff]) ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} text
 * @returns {string} 8 lowercase hex characters
 */
export function crc32Hex(text) {
	return crc32(Buffer.from(text, "utf8")).toString(16).padStart(8, "0");
}
