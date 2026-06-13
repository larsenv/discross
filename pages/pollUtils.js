'use strict';
const escapeHtml = require('escape-html');
const { renderTemplate, getTemplate, render } = require('./utils.js');
const { unicodeToTwemojiCode } = require('./emojiUtils.js');

const poll_template = getTemplate('poll', 'message');
const poll_answer_template = getTemplate('poll-answer', 'message');

function buildPollEmojiHtml(emoji, imagesCookie) {
    if (!emoji) return '';
    if (emoji.id && imagesCookie === 1) {
        const extension = emoji.animated ? 'gif' : 'png';
        return render('message/partials/poll-emoji-custom', {
            EMOJI_ID: emoji.id,
            EXT: extension,
        });
    }
    if (emoji.name && imagesCookie === 1) {
        // Reuse the canonical converter so poll emojis resolve to the same
        // twemoji files (and FE0F handling) used everywhere else in the app.
        return render('message/partials/poll-emoji-twemoji', {
            CODE: unicodeToTwemojiCode(emoji.name),
        });
    }
    if (emoji.name) {
        return render('message/partials/poll-emoji-text', {
            NAME: emoji.name,
        });
    }
    return '';
}

/**
 * Process a poll and render it as HTML
 * @param {Poll} poll - The Discord.js Poll object
 * @param {number} imagesCookie - Whether images are enabled (0 or 1)
 * @returns {string} HTML string for the poll
 */
function processPoll(poll, imagesCookie) {
    if (!poll) return '';

    try {
        // Check if poll has ended
        const now = Date.now();
        const isEnded = poll.expiresTimestamp && poll.expiresTimestamp < now;

        // Calculate total votes across all answers
        const totalVotes =
            poll.answers?.size > 0
                ? Array.from(poll.answers.values()).reduce((sum, a) => sum + (a.voteCount || 0), 0)
                : 0;

        // Find max votes for winning highlight
        const maxVotes = totalVotes > 0 
            ? Math.max(...Array.from(poll.answers.values()).map(a => a.voteCount || 0))
            : 0;

        // Process each answer
        const answersHtml =
            poll.answers?.size > 0
                ? Array.from(poll.answers.values())
                      .map((answer) => {
                          const voteCount = answer.voteCount || 0;
                          const votePercentage =
                              totalVotes > 0 ? Math.round((voteCount / totalVotes) * 100) : 0;
                          
                          const isWinner = isEnded && voteCount === maxVotes && maxVotes > 0;
                          const borderColor = isWinner ? '#23a559' : 'transparent';
                          const fillColor = isWinner ? '#1f3d2f' : '#3f4147';

                          return renderTemplate(poll_answer_template, {
                              '{$ANSWER_TEXT}': escapeHtml(answer.text || ''),
                              '{$ANSWER_EMOJI}': buildPollEmojiHtml(answer._emoji, imagesCookie),
                              '{$VOTE_COUNT}': voteCount,
                              '{$VOTE_PERCENTAGE}': votePercentage,
                              '{$BORDER_COLOR}': borderColor,
                              '{$FILL_COLOR}': fillColor,
                          });
                      })
                      .join('')
                : getTemplate('poll-no-answers', 'misc');

        // Create footer with poll metadata
        const footerParts = [`${totalVotes} vote${totalVotes !== 1 ? 's' : ''}`];

        if (poll.allowMultiselect) {
            footerParts.push('Multiple choice');
        }

        if (isEnded) {
            footerParts.push('Poll closed');
        } else if (poll.expiresTimestamp) {
            footerParts.push(`Ends ${new Date(poll.expiresTimestamp).toLocaleDateString()}`);
        }

        const pollHtml = renderTemplate(poll_template, {
            '{$POLL_QUESTION}': escapeHtml(poll.question?.text || 'Poll'),
            '{$POLL_ANSWERS}': answersHtml,
            '{$POLL_FOOTER}': escapeHtml(footerParts.join(' • ')),
        });

        return pollHtml;
    } catch (error) {
        console.error('Error processing poll:', error);
        return render('message/partials/poll-error', {
            MESSAGE: 'Error displaying poll',
        });
    }
}

module.exports = {
    processPoll,
};
