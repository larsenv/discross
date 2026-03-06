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
    let pollHtml = poll_template;

    // Set the poll question
    const question = poll.question?.text || 'Poll';
    pollHtml = strReplace(pollHtml, '{$POLL_QUESTION}', escape(question));

    // Calculate total votes across all answers
    let totalVotes = 0;
    if (poll.answers && poll.answers.size > 0) {
      poll.answers.forEach((answer) => {
        totalVotes += answer.voteCount || 0;
      });
    }

    // Process each answer
    let answersHtml = '';
    if (poll.answers && poll.answers.size > 0) {
      poll.answers.forEach((answer) => {
        let answerHtml = poll_answer_template;

        // Calculate vote percentage
        const voteCount = answer.voteCount || 0;
        const votePercentage = totalVotes > 0 ? Math.round((voteCount / totalVotes) * 100) : 0;

        // Get answer text
        const answerText = answer.text || '';
        answerHtml = strReplace(answerHtml, '{$ANSWER_TEXT}', escape(answerText));

        const emojiHtml = buildPollEmojiHtml(answer._emoji, imagesCookie);
        answerHtml = strReplace(answerHtml, '{$ANSWER_EMOJI}', emojiHtml);

        // Set vote count and percentage
        answerHtml = strReplace(answerHtml, '{$VOTE_COUNT}', voteCount);
        answerHtml = strReplace(answerHtml, '{$VOTE_PERCENTAGE}', votePercentage);

        answersHtml += answerHtml;
      });
    } else {
      answersHtml =
        '<div style="color: #72767d; font-size: 14px; font-style: italic;">No answers available</div>';
    }

    pollHtml = strReplace(pollHtml, '{$POLL_ANSWERS}', answersHtml);

    // Create footer with poll metadata
    const footerParts = [];
    footerParts.push(`${totalVotes} total vote${totalVotes !== 1 ? 's' : ''}`);

    if (poll.allowMultiselect) {
      footerParts.push('Multiple choice');
    }

    // Check if poll has ended
    const now = Date.now();
    if (poll.expiresTimestamp && poll.expiresTimestamp < now) {
      footerParts.push('Poll ended');
    } else if (poll.expiresTimestamp) {
      const expiresDate = new Date(poll.expiresTimestamp);
      footerParts.push(`Ends ${expiresDate.toLocaleDateString()}`);
    }

    const footer = footerParts.join(' • ');
    pollHtml = strReplace(pollHtml, '{$POLL_FOOTER}', escape(footer));

    return pollHtml;
  } catch (error) {
    console.error('Error processing poll:', error);
    return '<div style="color: #ed4245; font-size: 14px;">Error displaying poll</div>';
  }
}

module.exports = {
  processPoll,
};
