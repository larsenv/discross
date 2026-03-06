'use strict';
const fs = require('fs');
const escape = require('escape-html');
const { strReplace } = require('./utils.js');

const poll_template = fs.readFileSync('pages/templates/message/poll.html', 'utf-8');
const poll_answer_template = fs.readFileSync('pages/templates/message/poll_answer.html', 'utf-8');

function buildPollEmojiHtml(emoji, imagesCookie) {
  if (!emoji) return '';
  if (emoji.id && imagesCookie === 1) {
    const extension = emoji.animated ? 'gif' : 'png';
    return `<img src="/imageProxy/emoji/${emoji.id}.${extension}" width="20" height="20" style="width: 20px; height: 20px; vertical-align: middle;" alt="emoji">`;
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
    return `<img src="/resources/twemoji/${emojiCode}.gif" width="20" height="20" style="width: 20px; height: 20px; vertical-align: middle;" alt="emoji">`;
  }
  if (emoji.name) {
    return `<span style="font-size: 20px;">${emoji.name}</span>`;
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
              const withText = strReplace(
                poll_answer_template,
                '{$ANSWER_TEXT}',
                escape(answer.text || '')
              );
              const withEmoji = strReplace(
                withText,
                '{$ANSWER_EMOJI}',
                buildPollEmojiHtml(answer._emoji, imagesCookie)
              );
              const withCount = strReplace(withEmoji, '{$VOTE_COUNT}', voteCount);
              return strReplace(withCount, '{$VOTE_PERCENTAGE}', votePercentage);
            })
            .join('')
        : '<div style="color: #72767d; font-size: 14px; font-style: italic;">No answers available</div>';

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

    const withQuestion = strReplace(
      poll_template,
      '{$POLL_QUESTION}',
      escape(poll.question?.text || 'Poll')
    );
    const withAnswers = strReplace(withQuestion, '{$POLL_ANSWERS}', answersHtml);
    const pollHtml = strReplace(withAnswers, '{$POLL_FOOTER}', escape(footerParts.join(' • ')));

    return pollHtml;
  } catch (error) {
    console.error('Error processing poll:', error);
    return '<div style="color: #ed4245; font-size: 14px;">Error displaying poll</div>';
  }
}

module.exports = {
  processPoll,
};
