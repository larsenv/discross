'use strict';
const { renderTemplate, getTemplate } = require('./utils.js');
const sqlite3 = require('better-sqlite3');
const emojiRegex = require('./twemojiRegex').regex;

const db = new sqlite3('db/discross.db');

// Ensure cache tables exist on this connection before preparing statements
db.prepare(
    'CREATE TABLE IF NOT EXISTS emoji_cache (emoji_key TEXT PRIMARY KEY, twemoji_code TEXT)'
).run();
db.prepare(
    'CREATE TABLE IF NOT EXISTS custom_emoji_cache (emoji_id TEXT PRIMARY KEY, emoji_name TEXT, animated INTEGER)'
).run();

const _getCode = db.prepare('SELECT twemoji_code FROM emoji_cache WHERE emoji_key=?');
const _insertCode = db.prepare(
    'INSERT OR IGNORE INTO emoji_cache (emoji_key, twemoji_code) VALUES (?,?)'
);
const _insertCustom = db.prepare(
    'INSERT OR IGNORE INTO custom_emoji_cache (emoji_id, emoji_name, animated) VALUES (?,?,?)'
);

// In-memory caches to avoid repeated DB round-trips within the same process lifetime.
// unicodeToTwemojiCode: emoji string → codepoint string (e.g. "1f600")
const _emojiCodeCache = new Map();
// cacheCustomEmoji: set of emoji IDs already written to the DB this session
const _cachedCustomEmojiIds = new Set();

/**
 * Convert a unicode emoji string to its twemoji codepoint string.
 * Results are cached in the database to avoid recomputation.
 * @param {string} emojiStr - Unicode emoji character(s)
 * @returns {string} Twemoji codepoint string (e.g. "1f600" or "1f1fa-1f1f8")
 */
function unicodeToTwemojiCode(emojiStr) {
    // Fast path: in-memory cache hit (avoids SQLite round-trip entirely)
    const memCached = _emojiCodeCache.get(emojiStr);
    if (memCached !== undefined) return memCached;

    const dbCached = _getCode.get(emojiStr);
    if (dbCached) {
        _emojiCodeCache.set(emojiStr, dbCached.twemoji_code);
        return dbCached.twemoji_code;
    }

    // Strip U+FE0F (variation selector-16) unless the emoji contains U+200D (ZWJ).
    // This matches the official twemoji algorithm: keycap sequences like #️⃣ are
    // stored as "23-20e3.gif" (without fe0f), while ZWJ sequences like ❤️‍🔥 keep
    // the fe0f because it appears before the joiner ("2764-fe0f-200d-1f525.gif").
    const normalized = emojiStr.indexOf('\u200d') < 0 ? emojiStr.replace(/\ufe0f/g, '') : emojiStr;

    // This algorithm was inspired by the official Twitter Twemoji parser.
    const points = [];
    let char = 0,
        previous = 0,
        i = 0;
    while (i < normalized.length) {
        char = normalized.charCodeAt(i++);
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
    _emojiCodeCache.set(emojiStr, code);
    try {
        _insertCode.run(emojiStr, code);
    } catch (err) {
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
    // Skip the DB write if we already recorded this emoji in the current process lifetime
    if (_cachedCustomEmojiIds.has(emojiId)) return;
    _cachedCustomEmojiIds.add(emojiId);
    try {
        _insertCustom.run(emojiId, emojiName, animated ? 1 : 0);
    } catch (err) {
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
const tmpl = {
    image: getTemplate('twemoji_image', 'emojiUtils'),
};

function processUnicodeEmojiInText(text, sizePx, sizeEm) {
    return text.replace(emojiRegex, (match) => {
        const code = unicodeToTwemojiCode(match);
        return renderTemplate(tmpl.image, {
            CODE: code,
            PX: sizePx,
            EM: sizeEm,
        });
    });
}

module.exports = { unicodeToTwemojiCode, cacheCustomEmoji, processUnicodeEmojiInText };
