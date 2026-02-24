/**
 * Normalize "weird" Unicode characters to their ASCII/Latin equivalents,
 * while preserving legitimate foreign language characters (CJK, Arabic, Hebrew, etc.)
 *
 * Characters that ARE normalized (unusual/decorative Unicode):
 * - Mathematical Alphanumeric Symbols (𝗔𝗕𝗖 → ABC, 𝓗𝓮𝓪𝓽𝓱 → Heath)
 * - Full-width ASCII characters (ａｂｃ → abc, Ａ → A)
 * - Enclosed alphanumeric characters (Ⓐ → A, ① → 1)
 *
 * Characters that are NOT normalized (preserved as-is):
 * - CJK characters (Chinese, Japanese, Korean)
 * - Arabic, Hebrew, Thai, Devanagari, and other scripts
 * - Regular Latin, Cyrillic, Greek characters
 * - Half-width Katakana (Japanese)
 * - Emoji
 *
 * @param {string} str - Input string
 * @returns {string} String with weird Unicode normalized to ASCII equivalents
 */

// Upper bound (exclusive) of the ASCII character range
const ASCII_MAX = 0x80;

function normalizeWeirdUnicode(str) {
  if (!str) return str;

  let result = '';
  for (const char of str) {
    const code = char.codePointAt(0);

    // Full-width ASCII variants: U+FF01-U+FF5E → ASCII (subtract 0xFEE0)
    // Note: excludes U+FF61-U+FF9F (Half-width Katakana) which is legitimate Japanese
    if (code >= 0xFF01 && code <= 0xFF5E) {
      result += String.fromCodePoint(code - 0xFEE0);
      continue;
    }

    // Mathematical Alphanumeric Symbols: U+1D400-U+1D7FF
    // Styled versions of Latin letters and digits (bold, italic, script, fraktur, etc.)
    if (code >= 0x1D400 && code <= 0x1D7FF) {
      const normalized = char.normalize('NFKC');
      result += normalized;
      continue;
    }

    // Enclosed Alphanumerics: U+2460-U+24FF (circled letters/numbers: Ⓐ, ①, etc.)
    // Enclosed Alphanumeric Supplement: U+1F100-U+1F1FF
    if ((code >= 0x2460 && code <= 0x24FF) || (code >= 0x1F100 && code <= 0x1F1FF)) {
      const normalized = char.normalize('NFKC');
      // Only replace if normalized result is purely ASCII (single character)
      if (normalized.length === 1 && normalized.codePointAt(0) < ASCII_MAX) {
        result += normalized;
        continue;
      }
    }

    result += char;
  }

  return result;
}

module.exports = {
  normalizeWeirdUnicode
};
