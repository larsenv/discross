/**
 * Shared utilities for message processing
 */

const emojiRegex = require("./twemojiRegex").regex;

/**
 * Check if text contains only emojis (1-4 emojis)
 * @param {string} text - The message text to check
 * @returns {boolean} - True if message contains only 1-4 emojis, false otherwise
 */
function isEmojiOnlyMessage(text) {
  // Remove HTML tags and whitespace
  const cleanText = text.replace(/<[^>]*>/g, '').trim();
  
  // Check if the text matches only emoji pattern
  const emojiMatches = cleanText.match(emojiRegex);
  
  if (!emojiMatches) {
    return false;
  }
  
  // Join all emoji matches and see if they equal the entire clean text
  const allEmojis = emojiMatches.join('');
  const isOnlyEmojis = allEmojis === cleanText;
  
  // Return true if 1-4 emojis and nothing else
  return isOnlyEmojis && emojiMatches.length >= 1 && emojiMatches.length <= 4;
}

module.exports = {
  isEmojiOnlyMessage
};
