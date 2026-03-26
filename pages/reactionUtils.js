'use strict';
// Shared utility functions for processing and rendering reactions
const { unicodeToTwemojiCode, cacheCustomEmoji } = require('./emojiUtils');
const { renderTemplate, getTemplate } = require('./utils.js');

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
              return renderTemplate(getTemplate('emoji_custom', 'channel'), {
                EMOJI_ID: emoji.id,
                EXT: extension,
                PX: '21',
                STYLE: 'width: 21px; height: 21px; vertical-align: middle;',
              });
            }
            return `:${emoji.name}:`;
          }
          if (emoji.name) {
            if (imagesCookie === 1) {
              const output = unicodeToTwemojiCode(emoji.name);
              return renderTemplate(getTemplate('emoji_twemoji', 'channel'), {
                CODE: output,
                PX: '21',
                STYLE: 'width: 21px; height: 21px; vertical-align: middle;',
              });
            }
            return emoji.name;
          }
          return '';
        })();

        // Build the reaction HTML - skip if emoji couldn't be processed
        if (emojiHtml) {
          const reactionHtml = renderTemplate(reaction_template, {
            EMOJI: emojiHtml,
            COUNT: count,
            REACTION_BG: backgroundColor,
            REACTION_BORDER: borderColor,
          });
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
      return renderTemplate(reactions_template, { REACTIONS: reactionsHtml });
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
