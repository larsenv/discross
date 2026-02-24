/**
 * Normalize "weird" Unicode characters to their ASCII/Latin equivalents,
 * while preserving legitimate foreign language characters (CJK, Arabic, Hebrew, etc.)
 *
 * Characters that ARE normalized (unusual/decorative Unicode):
 * - Mathematical Alphanumeric Symbols (𝗔𝗕𝗖 → ABC, 𝓗𝓮𝓪𝓽𝓱 → Heath)
 * - Full-width ASCII characters (ａｂｃ → abc, Ａ → A)
 * - Enclosed alphanumeric characters (Ⓐ → A, ① → 1)
 * - Typographic punctuation (curly quotes → straight quotes, em/en dashes → hyphen, ellipsis → ...)
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

// Typographic punctuation substitutions: fancy/smart chars → plain ASCII equivalents
const TYPOGRAPHIC_MAP = {
  '\u2018': "'",  // LEFT SINGLE QUOTATION MARK  ' → '
  '\u2019': "'",  // RIGHT SINGLE QUOTATION MARK (Oxford apostrophe)  ' → '
  '\u201A': "'",  // SINGLE LOW-9 QUOTATION MARK  ‚ → '
  '\u201B': "'",  // SINGLE HIGH-REVERSED-9 QUOTATION MARK  ‛ → '
  '\u201C': '"',  // LEFT DOUBLE QUOTATION MARK  " → "
  '\u201D': '"',  // RIGHT DOUBLE QUOTATION MARK  " → "
  '\u201E': '"',  // DOUBLE LOW-9 QUOTATION MARK  „ → "
  '\u201F': '"',  // DOUBLE HIGH-REVERSED-9 QUOTATION MARK  ‟ → "
  '\u2010': '-',  // HYPHEN  ‐ → -
  '\u2011': '-',  // NON-BREAKING HYPHEN  ‑ → -
  '\u2012': '-',  // FIGURE DASH  ‒ → -
  '\u2013': '-',  // EN DASH  – → -
  '\u2014': '-',  // EM DASH  — → -
  '\u2015': '-',  // HORIZONTAL BAR  ― → -
  '\u2026': '...', // HORIZONTAL ELLIPSIS  … → ...
  '\u02BC': "'",  // MODIFIER LETTER APOSTROPHE  ʼ → '
  '\u02B9': "'",  // MODIFIER LETTER PRIME  ʹ → '
  '\u2032': "'",  // PRIME  ′ → '
  '\u2033': '"',  // DOUBLE PRIME  ″ → "
};

function normalizeWeirdUnicode(str) {
  if (!str) return str;

  let result = '';
  for (const char of str) {
    const code = char.codePointAt(0);

    // Typographic punctuation substitutions (curly quotes, dashes, ellipsis, etc.)
    if (TYPOGRAPHIC_MAP[char] !== undefined) {
      result += TYPOGRAPHIC_MAP[char];
      continue;
    }

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
