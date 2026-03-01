const { emojify } = require('discord-emoji-converter');

// Fitzpatrick skin-tone modifier characters for :skin-tone-2: through :skin-tone-6:
const SKIN_TONE_CHARS = { 2: '\u{1F3FB}', 3: '\u{1F3FC}', 4: '\u{1F3FD}', 5: '\u{1F3FE}', 6: '\u{1F3FF}' };

/**
 * Convert emoji shortcodes in message text to Unicode emoji characters.
 * Handles standard Discord shortcodes (e.g. :slight_smile: -> 🙂) and skin-tone
 * variants in both combined form (:thumbsup_tone2: -> 👍🏼) and split form
 * (:thumbsup::skin-tone-2: -> 👍🏻).
 * @param {string} message
 * @returns {string}
 */
function convertEmoji(message) {
  return emojify(message).replace(/:skin-tone-([2-6]):/g, (_, n) => SKIN_TONE_CHARS[n]);
}

module.exports = { convertEmoji };
