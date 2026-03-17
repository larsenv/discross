'use strict';
const { emojify } = require('discord-emoji-converter');

// Fitzpatrick skin-tone modifier characters for :skin-tone-2: through :skin-tone-6:
const SKIN_TONE_CHARS = {
  2: '\u{1F3FB}',
  3: '\u{1F3FC}',
  4: '\u{1F3FD}',
  5: '\u{1F3FE}',
  6: '\u{1F3FF}',
};

// ASCII emoji shortcut data sourced from
// https://gist.github.com/ThaTiemsz/6c443b4f28c07ab00539f399849292a6
const ASCII_EMOJI_SHORTCUTS = [
  { emoji: 'angry', shortcuts: ['>:(', '>:-(', '>=(', '>=-(' ] },
  { emoji: 'blush', shortcuts: [':")', ':-")', '=")', '=-")'] },
  { emoji: 'broken_heart', shortcuts: ['</3', '<\\3'] },
  { emoji: 'confused', shortcuts: [':-\\', ':-/', '=-\\', '=-/'] },
  { emoji: 'cry', shortcuts: [":'(", ":'-(" , ':,(', ':,-(', "='(", "='-(" , '=,(', '=,-(' ] },
  { emoji: 'frowning', shortcuts: [':(', ':-(', '=(', '=-(' ] },
  { emoji: 'heart', shortcuts: ['<3', '\u2661'] },
  { emoji: 'imp', shortcuts: [']:(', ']:-(', ']=(' , ']=-(' ] },
  { emoji: 'innocent', shortcuts: ['o:)', 'O:)', 'o:-)', 'O:-)', '0:)', '0:-)', 'o=)', 'O=)', 'o=-)', 'O=-)', '0=)', '0=-)'] },
  { emoji: 'joy', shortcuts: [":')", ":'-)", ':,)', ':,-)', ":'D", ":'-D", ':,D', ':,-D', "=')", "='-)", '=,)', '=,-)', "='D", "='-D", '=,D', '=,-D'] },
  { emoji: 'kissing', shortcuts: [':*', ':-*', '=*', '=-*'] },
  { emoji: 'laughing', shortcuts: ['x-)', 'X-)'] },
  { emoji: 'neutral_face', shortcuts: [':|', ':-|', '=|', '=-|'] },
  { emoji: 'open_mouth', shortcuts: [':o', ':-o', ':O', ':-O', '=o', '=-o', '=O', '=-O'] },
  { emoji: 'rage', shortcuts: [':@', ':-@', '=@', '=-@'] },
  { emoji: 'smile', shortcuts: [':D', ':-D', '=D', '=-D'] },
  { emoji: 'slight_smile', shortcuts: [':)', ':-)', '=)', '=-)'] },
  { emoji: 'smiling_imp', shortcuts: [']:)', ']:-)',']=)', ']=-)'] },
  { emoji: 'sob', shortcuts: [":,'(", ":,'-(", ';(', ';-(', "=,'(", "=,'-("] },
  { emoji: 'stuck_out_tongue', shortcuts: [':P', ':-P', '=P', '=-P'] },
  { emoji: 'sunglasses', shortcuts: ['8-)', 'B-)'] },
  { emoji: 'sweat', shortcuts: [',:(', ',:-(', ',=(', ',=-('] },
  { emoji: 'sweat_smile', shortcuts: [',:)', ',:-)',',=)', ',=-)'] },
  { emoji: 'unamused', shortcuts: [':s', ':-S', ':z', ':-Z', ':$', ':-$', '=s', '=-S', '=z', '=-Z', '=$', '=-$'] },
  { emoji: 'wink', shortcuts: [';)', ';-)'] },
];

// Build a Map from each shortcut string to its emoji name
const _shortcutMap = new Map();
for (const { emoji, shortcuts } of ASCII_EMOJI_SHORTCUTS) {
  for (const shortcut of shortcuts) {
    _shortcutMap.set(shortcut, emoji);
  }
}

// Sort shortcuts longest-first so longer patterns take priority over shorter ones
// (e.g. ":'(" matches before ":(")
const _sortedShortcuts = [..._shortcutMap.keys()].sort((a, b) => b.length - a.length);

function _escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const _shortcutsRegex = new RegExp(_sortedShortcuts.map(_escapeRegex).join('|'), 'g');

/**
 * Convert ASCII emoji shortcuts (e.g. :) :D <3) in message text to Unicode emoji.
 * Applied after standard shortcode conversion so that :emoji_name: patterns are
 * already resolved and cannot conflict with ASCII shortcuts like :s or :D.
 * @param {string} message
 * @returns {string}
 */
function _convertAsciiEmoji(message) {
  return message.replace(_shortcutsRegex, (match) => emojify(`:${_shortcutMap.get(match)}:`));
}

// Regex that matches a backslash followed by any ASCII emoji shortcut.
// Built once at module load like _shortcutsRegex.
const _escapedAsciiRegex = new RegExp(
  `\\\\(?:${_sortedShortcuts.map(_escapeRegex).join('|')})`,
  'g'
);

/**
 * Convert emoji shortcodes in message text to Unicode emoji characters.
 * Handles standard Discord shortcodes (e.g. :slight_smile: -> 🙂), skin-tone
 * variants in both combined form (:thumbsup_tone2: -> 👍🏼) and split form
 * (:thumbsup::skin-tone-2: -> 👍🏻), and ASCII shortcuts (e.g. :) :D <3).
 *
 * A leading backslash escapes conversion: \:slight_smile: stays as
 * :slight_smile: and \:-) becomes :slight_smile:, mirroring Discord's behaviour.
 * @param {string} message
 * @returns {string}
 */
function convertEmoji(message) {
  // Protect backslash-escaped items from conversion.
  // \:shortcode: and \<ascii-shortcut> are stored and restored later
  // without their leading backslash (Discord drops the backslash on send).
  const escaped = [];

  let withProtected = message.replace(/\\(:[a-zA-Z0-9_+\-]+:)/g, (match, shortcode) => {
    const idx = escaped.length;
    escaped.push(shortcode);
    return `\u0000ESC${idx}\u0000`;
  });

  withProtected = withProtected.replace(_escapedAsciiRegex, (match) => {
    const shortcut = match.slice(1); // strip the leading backslash
    const idx = escaped.length;
    const emojiName = _shortcutMap.get(shortcut);
    escaped.push(emojiName ? `:${emojiName}:` : shortcut);
    return `\u0000ESC${idx}\u0000`;
  });

  const afterShortcodes = emojify(withProtected).replace(
    /:skin-tone-([2-6]):/g,
    (_, n) => SKIN_TONE_CHARS[n]
  );

  const afterAscii = _convertAsciiEmoji(afterShortcodes);

  // Restore escaped items (without the leading backslash)
  return afterAscii.replace(/\u0000ESC(\d+)\u0000/g, (_, i) => escaped[parseInt(i, 10)]);
}

module.exports = { convertEmoji };
