'use strict';
const fs = require('fs');
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
    image: getTemplate('twemoji-image', 'emojiUtils'),
    skintone: getTemplate('skintone-button', 'emojiUtils'),
};

// Load emoji categories for server-side rendering
let emojiCategories = {};
try {
    const emojiListPath = require('path').join(__dirname, 'static/js/emojiList.js');
    const content = fs.readFileSync(emojiListPath, 'utf-8');
    // Extract JSON from window.EMOJI_CATEGORIES = {...};
    const jsonMatch = content.match(/window\.EMOJI_CATEGORIES\s*=\s*(\{.*\});/);
    if (jsonMatch) {
        emojiCategories = JSON.parse(jsonMatch[1]);
    }
} catch (err) {
    console.error('Failed to load emoji categories for server-side rendering:', err);
}

function getSkinToneSelectorHTML(baseUrl, emojiOpen, expanded, sessionParam) {
    const skinTones = [
        { tone: '', icon: '1f44f' },
        { tone: '1f3fb', icon: '1f44f-1f3fb' },
        { tone: '1f3fc', icon: '1f44f-1f3fc' },
        { tone: '1f3fd', icon: '1f44f-1f3fd' },
        { tone: '1f3fe', icon: '1f44f-1f3fe' },
        { tone: '1f3ff', icon: '1f44f-1f3ff' },
    ];

    // Preserve emoji=1 and expanded=1 in the links
    let extra = '';
    if (emojiOpen) extra += '&emoji=1';
    if (expanded) extra += '&expanded=1';

    return skinTones
        .map((st) => {
            // We need to inject skinTone into sessionParam or handle it separately
            let href = baseUrl;
            let finalSessionParam = sessionParam;

            // Remove existing skinTone from sessionParam if we are setting a new one
            if (st.tone) {
                if (finalSessionParam.includes('?')) {
                    finalSessionParam = finalSessionParam.replace(
                        /([?&])skinTone=[^&]*/,
                        '$1skinTone=' + st.tone
                    );
                    if (!finalSessionParam.includes('skinTone=')) {
                        finalSessionParam += '&skinTone=' + st.tone;
                    }
                } else {
                    finalSessionParam = '?skinTone=' + st.tone;
                }
            } else {
                // Remove skinTone param if tone is empty
                finalSessionParam = finalSessionParam
                    .replace(/[?&]skinTone=[^&]*/, '')
                    .replace('?&', '?');
                if (finalSessionParam === '?') finalSessionParam = '';
            }

            href += finalSessionParam;
            if (extra) {
                href +=
                    (href.includes('?') ? '' : '?') +
                    extra.replace(/^&/, href.includes('?') ? '&' : '');
            }

            return renderTemplate(tmpl.skintone, {
                TONE: st.tone,
                ICON: st.icon,
                HREF: href,
            });
        })
        .join('');
}

const quickNames = [
    'sob',
    'skull',
    'pleading_face',
    'heart',
    'joy',
    'fire',
    'white_check_mark',
    'eyes',
];

function renderEmojiLink(emoji, isCustom, skinTone, animated = false) {
    const code = isCustom ? emoji.id : emoji.code;
    const name = emoji.name;
    const supportsSkinTone = emoji.sk;

    let finalCode = code;
    if (!isCustom && supportsSkinTone && skinTone) {
        if (code.includes('-200d')) {
            // Common person base codepoints: 1f468 (man), 1f469 (woman), 1f9d1 (person), 1f466 (boy), 1f467 (girl), 1f6b6 (walking), 1f3c3 (running), 1f9ce (kneeling)
            finalCode = code.replace(
                /(1f468|1f469|1f9d1|1f466|1f467|1f6b6|1f3c3|1f9ce)(?=[-.]|$)/g,
                '$1-' + skinTone
            );
        } else {
            finalCode = code.replace('.gif', '-' + skinTone + '.gif');
        }
    }

    const src = isCustom
        ? `https://cdn.discordapp.com/emojis/${code}${animated ? '.gif' : '.png'}?size=48`
        : `/resources/twemoji/${finalCode}`;

    // For JS-free, we can't easily insert into the textarea without a form or JS.
    // But we can at least show them.
    return `<a title=":${name}:" style="display: inline-block; background: none; cursor: pointer; padding: 8px; border-radius: 4px; text-decoration: none;" onmouseover="this.style.backgroundColor='rgba(255, 255, 255, 0.1)'" onmouseout="this.style.backgroundColor='transparent'">
        <img src="${src}" alt="${name}" width="24" height="24" style="width: 24px; height: 24px" loading="lazy" />
    </a>`;
}

function getQuickEmojiHTML(skinTone) {
    const html = [];
    for (const name of quickNames) {
        // Find emoji in categories
        let found = null;
        for (const cat in emojiCategories) {
            found = emojiCategories[cat].find((e) => e.name === name);
            if (found) break;
        }
        if (found) {
            html.push(renderEmojiLink(found, false, skinTone));
        }
    }
    return html.join('');
}

function getExpandedEmojiHTML(skinTone, serverEmojis) {
    const html = [];

    // Server Emojis
    if (serverEmojis && serverEmojis.length > 0) {
        html.push(
            `<h3 style="margin: 8px 4px 4px 4px; color: #8e9297; font-size: 12px; text-transform: uppercase;">Server Emojis</h3>`
        );
        for (const e of serverEmojis) {
            html.push(renderEmojiLink(e, true, skinTone, e.animated));
        }
    }

    // Twemoji categories
    for (const cat in emojiCategories) {
        html.push(
            `<h3 style="margin: 16px 4px 4px 4px; color: #8e9297; font-size: 12px; text-transform: uppercase;">${cat}</h3>`
        );
        for (const e of emojiCategories[cat]) {
            html.push(renderEmojiLink(e, false, skinTone));
        }
    }

    return html.join('');
}

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

module.exports = {
    unicodeToTwemojiCode,
    cacheCustomEmoji,
    processUnicodeEmojiInText,
    getSkinToneSelectorHTML,
    getQuickEmojiHTML,
    getExpandedEmojiHTML,
};
