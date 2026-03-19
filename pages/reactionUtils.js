'use strict';
// Shared utility functions for processing and rendering reactions
const { unicodeToTwemojiCode, cacheCustomEmoji } = require('./emojiUtils');
const { strReplace } = require('./utils.js');

// Function to process and format reactions
function processReactions(
  reactions,
  imagesCookie,
  reactions_template,
  reaction_template,
  animationsCookie = 1
) {
  try {
    // In Discord.js v14, message.reactions is a ReactionManager with a cache property
    // that contains the Collection of MessageReaction objects. Handle both cases.
    const reactionCollection = reactions?.cache || reactions;

    if (!reactionCollection || reactionCollection.size === 0) {
      return '';
    }

    const reactionsHtml = Array.from(reactionCollection.values()).reduce((acc, reaction) => {
      try {
        const emoji = reaction.emoji;
        const count = reaction.count;

        // Determine if it's a super reaction based on burst colors
        const isSuperReaction = reaction.burst_colors && reaction.burst_colors.length > 0;

        // Set background and border colors
        const backgroundColor = isSuperReaction
          ? 'rgba(88, 101, 242, 0.15)'
          : 'rgba(79, 84, 92, 0.16)';
        const borderColor = isSuperReaction ? 'rgba(88, 101, 242, 0.4)' : 'rgba(79, 84, 92, 0.24)';

        const emojiHtml = (() => {
          if (emoji.id) {
            if (imagesCookie === 1) {
              const extension = emoji.animated && animationsCookie === 1 ? 'gif' : 'png';
              cacheCustomEmoji(emoji.id, emoji.name, emoji.animated);
              return `<img src="/imageProxy/emoji/${emoji.id}.${extension}" width="21" height="21" style="width: 21px; height: 21px; vertical-align: middle;" alt="emoji">`;
            }
            return `:${emoji.name}:`;
          }
          if (emoji.name) {
            if (imagesCookie === 1) {
              const output = unicodeToTwemojiCode(emoji.name);
              return `<img src="/resources/twemoji/${output}.gif" width="21" height="21" style="width: 21px; height: 21px; vertical-align: middle;" alt="emoji" onerror="this.style.display='none'">`;
            }
            return emoji.name;
          }
          return '';
        })();

        // Build the reaction HTML - skip if emoji couldn't be processed
        if (emojiHtml) {
          const withEmoji = strReplace(reaction_template, '{$EMOJI}', emojiHtml);
          const withCount = strReplace(withEmoji, '{$COUNT}', count);
          const withBg = strReplace(withCount, '{$REACTION_BG}', backgroundColor);
          const reactionHtml = strReplace(withBg, '{$REACTION_BORDER}', borderColor);
          return acc + reactionHtml;
        }
        return acc;
      } catch (err) {
        console.error('Error processing individual reaction:', err);
        // Continue processing other reactions even if one fails
        return acc;
      }
    }, '');

    if (reactionsHtml) {
      return strReplace(reactions_template, '{$REACTIONS}', reactionsHtml);
    }

    return '';
  } catch (err) {
    console.error('Error processing reactions:', err);
    return ''; // Return empty string on error - graceful fallback
  }
}

module.exports = {
  processReactions,
};
