const sqlite3 = require('better-sqlite3');
const emojiRegex = require('./twemojiRegex').regex;

const db = new sqlite3('db/discross.db');

// Ensure cache tables exist on this connection before preparing statements
db.prepare('CREATE TABLE IF NOT EXISTS emoji_cache (emoji_key TEXT PRIMARY KEY, twemoji_code TEXT)').run();
db.prepare('CREATE TABLE IF NOT EXISTS custom_emoji_cache (emoji_id TEXT PRIMARY KEY, emoji_name TEXT, animated INTEGER)').run();

const _getCode = db.prepare('SELECT twemoji_code FROM emoji_cache WHERE emoji_key=?');
const _insertCode = db.prepare('INSERT OR IGNORE INTO emoji_cache (emoji_key, twemoji_code) VALUES (?,?)');
const _insertCustom = db.prepare('INSERT OR IGNORE INTO custom_emoji_cache (emoji_id, emoji_name, animated) VALUES (?,?,?)');

/**
 * Convert a unicode emoji string to its twemoji codepoint string.
 * Results are cached in the database to avoid recomputation.
 * @param {string} emojiStr - Unicode emoji character(s)
 * @returns {string} Twemoji codepoint string (e.g. "1f600" or "1f1fa-1f1f8")
 */
function unicodeToTwemojiCode(emojiStr) {
  const cached = _getCode.get(emojiStr);
  if (cached) return cached.twemoji_code;

  // This algorithm was inspired by the official Twitter Twemoji parser.
  const points = [];
  let char = 0, previous = 0, i = 0;
  while (i < emojiStr.length) {
    char = emojiStr.charCodeAt(i++);
    if (previous) {
      points.push((0x10000 + ((previous - 0xd800) << 10) + (char - 0xdc00)).toString(16));
      previous = 0;
    } else if (char > 0xd800 && char <= 0xdbff) {
      previous = char;
    } else {
      points.push(char.toString(16));
    }
  }
  const code = points.join('-');
  try { _insertCode.run(emojiStr, code); } catch (err) {
    if (err.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY' && err.code !== 'SQLITE_CONSTRAINT') {
      console.error('emoji_cache write error:', err);
    }
  }
  return code;
}

/**
 * Store a custom emoji's metadata in the database cache.
 * @param {string} emojiId - Discord emoji ID
 * @param {string} emojiName - Emoji name
 * @param {boolean|number} animated - Whether the emoji is animated
 */
function cacheCustomEmoji(emojiId, emojiName, animated) {
  try { _insertCustom.run(emojiId, emojiName, animated ? 1 : 0); } catch (err) {
    if (err.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY' && err.code !== 'SQLITE_CONSTRAINT') {
      console.error('custom_emoji_cache write error:', err);
    }
  }
}

/**
 * Replace unicode emojis in text with twemoji <img> tags.
 * Always uses .gif extension since only GIF twemoji files are available.
 * @param {string} text - Text that may contain unicode emojis
 * @param {number} sizePx - Size in pixels (e.g. 22)
 * @param {string} sizeEm - Size in em (e.g. "1.375em")
 * @returns {string} Text with unicode emojis replaced by img tags
 */
function processUnicodeEmojiInText(text, sizePx, sizeEm) {
  if (!text.match(emojiRegex)) return text;
  const matches = [...text.match(emojiRegex)];
  matches.forEach(match => {
    const code = unicodeToTwemojiCode(match);
    text = text.replace(match, `<img src="/resources/twemoji/${code}.gif" width="${sizePx}" height="${sizePx}" style="width: ${sizeEm}; height: ${sizeEm}; vertical-align: -0.2em;" alt="emoji" onerror="this.style.display='none'">`);
  });
  return text;
}

module.exports = { unicodeToTwemojiCode, cacheCustomEmoji, processUnicodeEmojiInText };
