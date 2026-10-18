// Builds pages/static/js/emojiKeywords.js, the search keywords for the emoji picker.
//
// The picker's emojiList.js only stores one shortcode per emoji, so a search
// for "toast" could never find :bread:. This joins every emoji in emojiList.js
// with the CLDR annotations from emojibase and the tags from gemoji, and writes
// them as `window.EMOJI_KEYWORDS = { "<code without .gif>": "word word ..." }`.
//
// Usage:
//   node scripts/buildEmojiKeywords.js <gemoji emoji.json> <emojibase en/data.json>
// Sources:
//   https://raw.githubusercontent.com/github/gemoji/master/db/emoji.json
//   https://cdn.jsdelivr.net/npm/emojibase-data@latest/en/data.json

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const [gemojiPath, emojibasePath] = process.argv.slice(2);
if (!gemojiPath || !emojibasePath) {
    console.error(
        'Usage: node scripts/buildEmojiKeywords.js <gemoji emoji.json> <emojibase en/data.json>'
    );
    process.exit(1);
}

const gemoji = JSON.parse(fs.readFileSync(gemojiPath, 'utf-8'));
const emojibase = JSON.parse(fs.readFileSync(emojibasePath, 'utf-8'));

const listPath = path.join(__dirname, '../pages/static/js/emojiList.js');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(listPath, 'utf-8'), sandbox);
const categories = sandbox.window.EMOJI_CATEGORIES;

// "1F468-200D-1F4BB" and "1f468-200d-1f4bb" (with or without FE0F) are the same emoji.
const normalizeHex = (hex) =>
    hex
        .toLowerCase()
        .split('-')
        .filter((h) => h !== 'fe0f')
        .join('-');

const toHex = (emoji) =>
    Array.from(emoji)
        .map((c) => c.codePointAt(0).toString(16))
        .join('-');

const byHex = new Map();
const addSource = (hex, words) => {
    const key = normalizeHex(hex);
    byHex.set(key, (byHex.get(key) || []).concat(words));
};

for (const e of emojibase) {
    addSource(e.hexcode, [e.label].concat(e.tags || []));
}
for (const g of gemoji) {
    addSource(toHex(g.emoji), [g.description].concat(g.aliases || [], g.tags || []));
}

// Words that would match half the emoji without meaning anything.
const STOPWORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'the', 'to', 'with']);

const toWords = (text) =>
    text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/['\u2019]/g, '')
        .split(/[^a-z0-9+]+/)
        .filter((w) => w && !STOPWORDS.has(w));

const keywords = {};
let total = 0;
let withKeywords = 0;
for (const cat in categories) {
    for (const emoji of categories[cat]) {
        total++;
        const hex = emoji.code.replace('.gif', '');
        const own = new Set(toWords(emoji.name.replace(/_/g, ' ')));
        const seen = new Set();
        const words = [];
        for (const text of byHex.get(normalizeHex(hex)) || []) {
            for (const w of toWords(text)) {
                // The picker already matches on the name, so don't repeat it here.
                if (own.has(w) || seen.has(w)) continue;
                seen.add(w);
                words.push(w);
            }
        }
        if (words.length > 0) {
            keywords[hex] = words.join(' ');
            withKeywords++;
        }
    }
}

const out = path.join(__dirname, '../pages/static/js/emojiKeywords.js');
fs.writeFileSync(out, 'window.EMOJI_KEYWORDS = ' + JSON.stringify(keywords) + ';\n');
console.log(
    'Wrote keywords for ' +
        withKeywords +
        ' of ' +
        total +
        ' emoji (' +
        fs.statSync(out).size +
        ' bytes).'
);
