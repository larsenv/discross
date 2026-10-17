'use strict';
const escapeHtml = require('escape-html');
const { renderTemplate, getTemplate, render } = require('./utils');
const { unicodeToTwemojiCode } = require('./emojiUtils');

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
            NAME: escapeHtml(emoji.name),
        });
    }
    return '';
}

/**
 * Time left before a poll closes, as Discord words it ("5h left").
 * @param {number} ms - Milliseconds remaining
 */
function formatTimeLeft(ms) {
    const minutes = Math.max(1, Math.ceil(ms / 60000));
    if (minutes >= 24 * 60) return `${Math.floor(minutes / (24 * 60))}d left`;
    if (minutes >= 60) return `${Math.floor(minutes / 60)}h left`;
    return `${minutes}m left`;
}

/**
 * Process a poll and render it as HTML, laid out like Discord's poll card:
 * question, how many answers may be picked, one row per answer with its
 * share of the vote as a fill bar, and a footer with the vote count and
 * time left (or "Poll closed"). Discross can't vote, so results always show.
 * @param {Poll} poll - The Discord.js Poll object
 * @param {number} imagesCookie - Whether images are enabled (0 or 1)
 * @returns {string} HTML string for the poll
 */
function processPoll(poll, imagesCookie) {
    if (!poll) return '';

    try {
        const now = Date.now();
        const isEnded =
            !!poll.resultsFinalized || (!!poll.expiresTimestamp && poll.expiresTimestamp < now);

        const answers = poll.answers?.size > 0 ? (Array.from(poll.answers.values()) as any[]) : [];
        const totalVotes = answers.reduce((sum, a) => sum + (a.voteCount || 0), 0);
        const maxVotes = answers.reduce((max, a) => Math.max(max, a.voteCount || 0), 0);

        const answersHtml =
            answers.length > 0
                ? answers
                      .map((answer) => {
                          const voteCount = answer.voteCount || 0;
                          const votePercentage =
                              totalVotes > 0 ? Math.round((voteCount / totalVotes) * 100) : 0;
                          // Once a poll closes Discord outlines every answer that
                          // tied for the most votes in green.
                          const isWinner = isEnded && maxVotes > 0 && voteCount === maxVotes;

                          return renderTemplate(poll_answer_template, {
                              '{$ANSWER_TEXT}': escapeHtml(answer.text || ''),
                              '{$ANSWER_EMOJI}': buildPollEmojiHtml(answer._emoji, imagesCookie),
                              '{$VOTE_COUNT}': `${voteCount} vote${voteCount === 1 ? '' : 's'}`,
                              '{$VOTE_PERCENTAGE}': votePercentage,
                              '{$WINNER_CLASS}': isWinner ? ' poll-answer-winner' : '',
                          });
                      })
                      .join('')
                : getTemplate('poll-no-answers', 'misc');

        const footerParts = [`${totalVotes} vote${totalVotes !== 1 ? 's' : ''}`];
        if (isEnded) {
            footerParts.push('Poll closed');
        } else if (poll.expiresTimestamp) {
            footerParts.push(formatTimeLeft(poll.expiresTimestamp - now));
        }

        return renderTemplate(poll_template, {
            '{$POLL_QUESTION}': escapeHtml(poll.question?.text || 'Poll'),
            '{$POLL_SUBTITLE}': isEnded
                ? ''
                : render('message/poll-subtitle', {
                      TEXT: poll.allowMultiselect
                          ? 'Select one or more answers'
                          : 'Select one answer',
                  }),
            '{$POLL_ANSWERS}': answersHtml,
            '{$POLL_FOOTER}': escapeHtml(footerParts.join(' \u00b7 ')),
        });
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
