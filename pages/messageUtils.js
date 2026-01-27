/**
 * Shared utilities for message processing
 */

const emojiRegex = require("./twemojiRegex").regex;

/**
 * Check if text contains only emojis (1-4 emojis)
 * NOTE: This function is for detection only, not for HTML sanitization.
 * The input text has already been processed by markdown-it which handles HTML escaping.
 * @param {string} text - The message text to check (already HTML-escaped by markdown-it)
 * @returns {boolean} - True if message contains only 1-4 emojis, false otherwise
 */
function isEmojiOnlyMessage(text) {
  // Remove HTML tags and HTML entities for emoji detection
  // This is NOT for security sanitization - input is already escaped by markdown-it
  const cleanText = text.replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, '').trim();
  
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
