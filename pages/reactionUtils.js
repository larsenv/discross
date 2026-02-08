// Shared utility functions for processing and rendering reactions

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || "");
}

// Function to process and format reactions
function processReactions(reactions, imagesCookie, reactions_template, reaction_template) {
  try {
    // In Discord.js v14, message.reactions is a ReactionManager with a cache property
    // that contains the Collection of MessageReaction objects. Handle both cases.
    const reactionCollection = reactions?.cache || reactions;
    
    if (!reactionCollection || reactionCollection.size === 0) {
      return '';
    }

    let reactionsHtml = '';
    
    reactionCollection.forEach((reaction) => {
      try {
        const emoji = reaction.emoji;
        const count = reaction.count;
        
        // Determine if it's a super reaction based on burst colors
        const isSuperReaction = reaction.burst_colors && reaction.burst_colors.length > 0;
        
        // Set background and border colors
        let backgroundColor, borderColor;
        if (isSuperReaction) {
          // Super reactions have a different background
          backgroundColor = 'rgba(88, 101, 242, 0.15)'; // Purple-ish tint for super reactions
          borderColor = 'rgba(88, 101, 242, 0.4)';
        } else {
          // Normal reactions
          backgroundColor = 'rgba(79, 84, 92, 0.16)';
          borderColor = 'rgba(79, 84, 92, 0.24)';
        }
        
        let emojiHtml = '';
        
        if (emoji.id) {
          // Custom emoji
          if (imagesCookie === 1) {
            const extension = emoji.animated ? 'gif' : 'png';
            emojiHtml = `<img src="/imageProxy/emoji/${emoji.id}.${extension}" style="width: 16px; height: 16px; vertical-align: middle;" alt="emoji">`;
          } else {
            // Fallback to emoji name if images are disabled
            emojiHtml = `:${emoji.name}:`;
          }
        } else if (emoji.name) {
          // Unicode emoji (twemoji)
          if (imagesCookie === 1) {
            // Convert unicode emoji to twemoji format
            const points = [];
            let char = 0;
            let previous = 0;
            let i = 0;
            let output = '';
            
            while (i < emoji.name.length) {
              char = emoji.name.charCodeAt(i++);
              if (previous) {
                points.push((0x10000 + ((previous - 0xd800) << 10) + (char - 0xdc00)).toString(16));
                previous = 0;
              } else if (char > 0xd800 && char <= 0xdbff) {
                previous = char;
              } else {
                points.push(char.toString(16));
              }
            }
            output = points.join("-");
            
            emojiHtml = `<img src="/resources/twemoji/${output}.gif" style="width: 16px; height: 16px; vertical-align: middle;" alt="emoji" onerror="this.style.display='none'">`;
          } else {
            // Show the unicode emoji directly
            emojiHtml = emoji.name;
          }
        }
        
        // Build the reaction HTML - skip if emoji couldn't be processed
        if (emojiHtml) {
          let reactionHtml = reaction_template;
          reactionHtml = strReplace(reactionHtml, '{$EMOJI}', emojiHtml);
          reactionHtml = strReplace(reactionHtml, '{$COUNT}', count.toString());
          reactionHtml = strReplace(reactionHtml, '{$REACTION_BG}', backgroundColor);
          reactionHtml = strReplace(reactionHtml, '{$REACTION_BORDER}', borderColor);
          
          reactionsHtml += reactionHtml;
        }
      } catch (err) {
        console.error('Error processing individual reaction:', err);
        // Continue processing other reactions even if one fails
      }
    });
    
    if (reactionsHtml) {
      return reactions_template.replace('{$REACTIONS}', reactionsHtml);
    }
    
    return '';
  } catch (err) {
    console.error('Error processing reactions:', err);
    return ''; // Return empty string on error - graceful fallback
  }
}

module.exports = {
  processReactions
};
