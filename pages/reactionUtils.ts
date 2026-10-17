'use strict';
// Shared utility functions for processing and rendering reactions
const { unicodeToTwemojiCode, cacheCustomEmoji } = require('./emojiUtils');
const escapeHtml = require('escape-html');
const { renderTemplate, render } = require('./utils');

const REACTION_EMOJI_STYLE = 'width: 16px; height: 16px; vertical-align: -3px;';

function renderReactionEmoji(emoji, imagesCookie, animationsCookie) {
    if (emoji?.id) {
        if (imagesCookie !== 1) return `:${escapeHtml(emoji.name || '')}:`;
        cacheCustomEmoji(emoji.id, emoji.name, emoji.animated);
        return render('channel/emoji-custom', {
            EMOJI_ID: emoji.id,
            EXT: emoji.animated && animationsCookie === 1 ? 'gif' : 'png',
            PX: '16',
            STYLE: REACTION_EMOJI_STYLE,
        });
    }
    if (emoji?.name) {
        if (imagesCookie !== 1) return escapeHtml(emoji.name);
        return render('channel/emoji-twemoji', {
            CODE: unicodeToTwemojiCode(emoji.name),
            PX: '16',
            STYLE: REACTION_EMOJI_STYLE,
        });
    }
    return '';
}

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

        const reactionsHtml = (Array.from(reactionCollection.values()) as any[])
            .map((reaction) => {
                try {
                    const emoji = reaction.emoji;
                    const emojiHtml = renderReactionEmoji(emoji, imagesCookie, animationsCookie);
                    // Skip if the emoji couldn't be rendered at all.
                    if (!emojiHtml) return '';

                    // Discord shows super reactions as their own pill, outlined in
                    // the emoji's burst colour, next to the normal reactions.
                    const details = reaction.countDetails ?? reaction.count_details;
                    const burst = details?.burst ?? 0;
                    const normal = details ? (details.normal ?? 0) : reaction.count || 0;
                    const burstColor = (reaction.burstColors ?? reaction.burst_colors ?? [])[0];

                    let html = '';
                    if (burst > 0) {
                        html += renderTemplate(reaction_template, {
                            EMOJI: emojiHtml,
                            COUNT: burst,
                            CLASS: ' reaction-burst',
                            STYLE: /^#[0-9a-f]{6}$/i.test(burstColor || '')
                                ? ` style="border-color: ${burstColor};"`
                                : '',
                        });
                    }
                    if (normal > 0 || burst === 0) {
                        html += renderTemplate(reaction_template, {
                            EMOJI: emojiHtml,
                            COUNT: normal || reaction.count || 0,
                            CLASS: '',
                            STYLE: '',
                        });
                    }
                    return html;
                } catch (err) {
                    console.error('Error processing individual reaction:', err);
                    // Continue processing other reactions even if one fails
                    return '';
                }
            })
            .join('');

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
