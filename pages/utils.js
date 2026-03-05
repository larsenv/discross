/**
 * Shared utility functions used across multiple page modules.
 */

/**
 * Replaces all occurrences of `needle` in `string` with `replacement`.
 * Built-in String.prototype.replace() only replaces the first occurrence.
 *
 * @param {string} string - The source string.
 * @param {string} needle - The substring to search for.
 * @param {string} [replacement=""] - The replacement value.
 * @returns {string}
 */
function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement ?? '');
}

/**
 * Returns true if `id` is a plausible Discord snowflake (16-20 decimal digits).
 *
 * @param {string} id
 * @returns {boolean}
 */
function isValidSnowflake(id) {
  return typeof id === 'string' && /^[0-9]{16,20}$/.test(id);
}

module.exports = { strReplace, isValidSnowflake };
