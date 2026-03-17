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

/**
 * Convert emoji shortcodes in message text to Unicode emoji characters.
 * Handles standard Discord shortcodes (e.g. :slight_smile: -> 🙂), skin-tone
 * variants in both combined form (:thumbsup_tone2: -> 👍🏼) and split form
 * (:thumbsup::skin-tone-2: -> 👍🏻), and ASCII shortcuts (e.g. :) :D <3).
 * @param {string} message
 * @returns {string}
 */
function convertEmoji(message) {
  const afterShortcodes = emojify(message).replace(
    /:skin-tone-([2-6]):/g,
    (_, n) => SKIN_TONE_CHARS[n]
  );
  return _convertAsciiEmoji(afterShortcodes);
}

module.exports = { convertEmoji };
