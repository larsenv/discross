'use strict';
const escape = require('escape-html');
const { renderDiscordMarkdown } = require('./discordMarkdown');
const { formatDateWithTimezone } = require('../timezoneUtils');
const fs = require('fs');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const { processUnicodeEmojiInText, cacheCustomEmoji } = require('./emojiUtils');
const { strReplace, parseCookies } = require('./utils.js');

const embed_template = fs.readFileSync('pages/templates/message/embed.html', 'utf-8');

/**
 * Encode an external image URL for use with the /imageProxy/external/ route.
 * @param {string} url - Raw image URL
 * @returns {string} Proxy path ready to embed in HTML
 */
function proxyExternalImageUrl(url) {
  return `/imageProxy/external/${Buffer.from(url).toString('base64')}`;
}

/**
 * Process emoji in rendered HTML text
 * @param {string} text - HTML text that may contain emoji codes
 * @param {number} imagesCookie - Cookie value indicating if images should be displayed
 * @param {number} animationsCookie - Cookie value for animation setting
 * @returns {string} HTML with emoji replaced by images
 */
function processEmojiInHTML(text, imagesCookie, animationsCookie) {
  if (imagesCookie !== 1) {
    return text;
  }

  // Process unicode emojis (twemoji) — cached via emojiUtils, always GIF
  const withUnicode = processUnicodeEmojiInText(text, 20, '1.25em');

  // Process custom emoji (HTML escaped format from markdown)
  const customEmojiMatches = [
    ...withUnicode.matchAll(/&lt;(:)?(?:(a):)?(\w{2,32}):(\d{17,19})?(?:(?!\1).)*&gt;/g),
  ];
  // Cache emoji metadata first (side effect), then transform string (pure reduce)
  for (const match of customEmojiMatches) {
    const emojiId = match[4];
    if (emojiId) cacheCustomEmoji(emojiId, match[3], !!match[2]);
  }
  const result = customEmojiMatches.reduce((acc, match) => {
    const animated = !!match[2]; // 'a' means animated
    const emojiId = match[4];
    if (!emojiId) return acc;
    const emojiExt = animated && animationsCookie === 1 ? 'gif' : 'png';
    return acc.replace(
      match[0],
      `<img src="/imageProxy/emoji/${emojiId}.${emojiExt}" width="20" height="20" style="width: 1.25em; height: 1.25em; vertical-align: -0.2em;" alt="emoji" onerror="this.style.display='none'">`
    );
  }, withUnicode);

  return result;
}

/**
 * Process Discord embeds into HTML
 * @param {Array} embeds - Array of Discord embed objects
 * @param {number} imagesCookie - Cookie value indicating if images should be displayed (1 = yes, 0 = no)
 * @param {number} animationsCookie - Cookie value for animation setting (default 1)
 * @param {string|null} clientTimezone - User's timezone for date formatting
 * @returns {string} HTML string representing all embeds
 */
function processEmbeds(req, embeds, imagesCookie, animationsCookie = 1, clientTimezone = null) {
  const cookies = parseCookies(req);
  const themeValue = parseInt(cookies.whiteThemeCookie, 10) || 0;

  // Apply theme colors: 1=light, otherwise dark/amoled
  const embedHead = themeValue === 1 ? '#000000' : '#ffffff';
  const embedText = themeValue === 1 ? '#000000' : '#dcddde';

  if (!embeds || embeds.length === 0) {
    return '';
  }

  const embedsHtml = embeds
    .map((embed) => {
      // Set embed color (default to #202225 if not present)
      const embedColor = embed.color ? `#${embed.color.toString(16).padStart(6, '0')}` : '#202225';

      // Process embed author
      const authorContent = embed.author
        ? `<span style="font-size: 14px; font-weight: 600; color: #${embedHead};">${escape(normalizeWeirdUnicode(embed.author.name))}</span>`
        : '';
      const authorHtml =
        embed.author && authorContent
          ? embed.author.url
            ? `<a href="${escape(embed.author.url)}" target="_blank" style="text-decoration: none; color: inherit;">${authorContent}</a>`
            : authorContent
          : '';

      // Process embed title
      const titleContent = embed.title
        ? embed.url
          ? `<a href="${escape(embed.url)}" target="_blank" style="color: #00b0f4; text-decoration: none;">${escape(normalizeWeirdUnicode(embed.title))}</a>`
          : escape(normalizeWeirdUnicode(embed.title))
        : '';
      const titleHtml = titleContent
        ? `<div style="font-size: 16px; font-weight: 600; color: #ffffff; margin-bottom: 8px;">${titleContent}</div>`
        : '';

      // Process embed description with emoji support (#11)
      const processedDescription = embed.description
        ? processEmojiInHTML(
            renderDiscordMarkdown(embed.description),
            imagesCookie,
            animationsCookie
          )
        : null;
      const descriptionHtml = processedDescription
        ? `<div style="font-size: 14px; color: #${embedText}; margin-bottom: 8px; white-space: pre-wrap;">${processedDescription}</div>`
        : '';

      // Process embed fields with emoji support (#11)
      const fieldsHtml = (() => {
        if (!embed.fields || embed.fields.length === 0) return '';
        const { body: tableBody, rowOpen: lastRowOpen } = embed.fields.reduce(
          (state, field, i) => {
            let { body, rowOpen, inlineCount } = state;
            if (!field.inline) {
              if (rowOpen) {
                body += '</tr>';
                rowOpen = false;
                inlineCount = 0;
              }
              body +=
                '<tr><td colspan="3" style="padding-bottom: 4px; overflow-wrap: break-word; word-wrap: break-word;">';
              body += `<div style="font-size: 14px; font-weight: 600; color: #${embedHead}; margin-bottom: 4px;">${renderDiscordMarkdown(normalizeWeirdUnicode(field.name))}</div>`;
              const renderedValue = renderDiscordMarkdown(field.value);
              body += `<div style="font-size: 14px; color: #${embedText}; white-space: pre-wrap;">${processEmojiInHTML(renderedValue, imagesCookie, animationsCookie)}</div>`;
              body += '</td></tr>';
            } else {
              if (!rowOpen) {
                body += '<tr>';
                rowOpen = true;
                inlineCount = 0;
              }
              body +=
                '<td valign="top" style="padding-bottom: 4px; padding-right: 4px; overflow-wrap: break-word; word-wrap: break-word;">';
              body += `<div style="font-size: 14px; font-weight: 600; color: #${embedHead}; margin-bottom: 4px;">${renderDiscordMarkdown(normalizeWeirdUnicode(field.name))}</div>`;
              const renderedValue = renderDiscordMarkdown(field.value);
              body += `<div style="font-size: 14px; color: #${embedText}; white-space: pre-wrap;">${processEmojiInHTML(renderedValue, imagesCookie, animationsCookie)}</div>`;
              body += '</td>';
              inlineCount++;
              const nextField = embed.fields[i + 1];
              if (inlineCount >= 3 || !nextField || !nextField.inline) {
                body += '</tr>';
                rowOpen = false;
                inlineCount = 0;
              }
            }
            return { body, rowOpen, inlineCount };
          },
          { body: '', rowOpen: false, inlineCount: 0 }
        );
        const closingTag = lastRowOpen ? '</tr>' : '';
        return (
          '<table width="100%" cellpadding="2" cellspacing="0" style="margin-bottom: 8px; table-layout: fixed;">' +
          tableBody +
          closingTag +
          '</table>'
        );
      })();

      // Process embed image (#29 - restore image rendering)
      const imageHtml =
        embed.image && imagesCookie === 1
          ? `<div style="margin-top: 8px;"><img src="${escape(proxyExternalImageUrl(embed.image.url || embed.image.proxyURL))}" style="max-width: 100%; max-height: 200px; border-radius: 4px; height: auto;" alt="Embed image"></div>`
          : '';

      // Process embed thumbnail (#29 - restore thumbnail rendering)
      // Thumbnail should be positioned BEFORE title/description so it floats to top-right
      const thumbnailHtml =
        embed.thumbnail && imagesCookie === 1
          ? `<div style="float: right; margin-left: 12px; margin-bottom: 8px;"><img src="${escape(proxyExternalImageUrl(embed.thumbnail.url || embed.thumbnail.proxyURL))}" style="max-width: 80px; max-height: 80px; border-radius: 4px;" alt="Thumbnail"></div>`
          : '';

      // Process embed footer
      const footerHtml = (() => {
        if (!embed.footer && !embed.timestamp) return '';
        const footerText = embed.footer
          ? `<span>${escape(normalizeWeirdUnicode(embed.footer.text))}</span>`
          : '';
        const separator =
          embed.footer && embed.timestamp ? '<span style="margin: 0 4px;">•</span>' : '';
        const timestamp = embed.timestamp
          ? `<span>${formatDateWithTimezone(new Date(embed.timestamp), clientTimezone)}</span>`
          : '';
        return `<div style="margin-top: 8px; font-size: 12px; color: #72767d;">${footerText}${separator}${timestamp}</div>`;
      })();

      const withColor = strReplace(embed_template, '{$EMBED_COLOR}', embedColor);
      const withAuthor = strReplace(withColor, '{$EMBED_AUTHOR}', authorHtml);
      const withTitle = strReplace(withAuthor, '{$EMBED_TITLE}', titleHtml);
      const withDescription = strReplace(withTitle, '{$EMBED_DESCRIPTION}', descriptionHtml);
      const withFields = strReplace(withDescription, '{$EMBED_FIELDS}', fieldsHtml);
      const withImage = strReplace(withFields, '{$EMBED_IMAGE}', imageHtml);
      const withThumbnail = strReplace(withImage, '{$EMBED_THUMBNAIL}', thumbnailHtml);
      const embedHtml = strReplace(withThumbnail, '{$EMBED_FOOTER}', footerHtml);

      // Margin right wrapper
      return `<div style="margin-right: 8px;">${embedHtml}</div>`;
    })
    .join('');

  return embedsHtml;
}

module.exports = {
  processEmbeds,
};
