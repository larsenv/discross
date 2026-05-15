'use strict';
const { renderTemplate, getTemplate, render } = require('./utils.js');

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
        const codePoints = [];
        for (let i = 0; i < emoji.name.length; i++) {
            const code = emoji.name.codePointAt(i);
            if (code) {
                codePoints.push(code.toString(16));
                if (code > 0xffff) i++;
            }
        }
        const emojiCode = codePoints.join('-');
        return render('message/partials/poll-emoji-twemoji', {
            CODE: emojiCode,
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
        // Calculate total votes across all answers
        const totalVotes =
            poll.answers?.size > 0
                ? Array.from(poll.answers.values()).reduce((sum, a) => sum + (a.voteCount || 0), 0)
                : 0;

        // Process each answer
        const answersHtml =
            poll.answers?.size > 0
                ? Array.from(poll.answers.values())
                      .map((answer) => {
                          const voteCount = answer.voteCount || 0;
                          const votePercentage =
                              totalVotes > 0 ? Math.round((voteCount / totalVotes) * 100) : 0;
                          return renderTemplate(poll_answer_template, {
                              '{$ANSWER_TEXT}': escape(answer.text || ''),
                              '{$ANSWER_EMOJI}': buildPollEmojiHtml(answer._emoji, imagesCookie),
                              '{$VOTE_COUNT}': voteCount,
                              '{$VOTE_PERCENTAGE}': votePercentage,
                          });
                      })
                      .join('')
                : getTemplate('poll-no-answers', 'misc');

        // Create footer with poll metadata
        const footerParts = [`${totalVotes} total vote${totalVotes !== 1 ? 's' : ''}`];

        if (poll.allowMultiselect) {
            footerParts.push('Multiple choice');
        }

        // Check if poll has ended
        const now = Date.now();
        if (poll.expiresTimestamp && poll.expiresTimestamp < now) {
            footerParts.push('Poll ended');
        } else if (poll.expiresTimestamp) {
            footerParts.push(`Ends ${new Date(poll.expiresTimestamp).toLocaleDateString()}`);
        }

        const pollHtml = renderTemplate(poll_template, {
            '{$POLL_QUESTION}': escape(poll.question?.text || 'Poll'),
            '{$POLL_ANSWERS}': answersHtml,
            '{$POLL_FOOTER}': escape(footerParts.join(' • ')),
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
