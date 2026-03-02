const escape = require('escape-html');
const md = require('markdown-it')({ breaks: true, linkify: true });
const { renderDiscordMarkdown } = require('./discordMarkdown');
const { formatDateWithTimezone } = require('../timezoneUtils');
const fs = require('fs');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const { processUnicodeEmojiInText, cacheCustomEmoji } = require('./emojiUtils');

const embed_template = fs.readFileSync('pages/templates/message/embed.html', 'utf-8');

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || "");
}

/**
 * Process emoji in rendered HTML text
 * @param {string} text - HTML text that may contain emoji codes
 * @param {number} imagesCookie - Cookie value indicating if images should be displayed
 * @param {number} animationsCookie - Cookie value for animation setting
 * @returns {string} HTML with emoji replaced by images
 */
function processEmojiInHTML(text, imagesCookie, animationsCookie) {
  if (imagesCookie != 1) {
    return text;
  }
  
  let result = text;

  // Process unicode emojis (twemoji) — cached via emojiUtils, always GIF
  result = processUnicodeEmojiInText(result, 20, '1.25em');

  // Process custom emoji (HTML escaped format from markdown)
  const customEmojiMatches = [...result.matchAll(/&lt;(:)?(?:(a):)?(\w{2,32}):(\d{17,19})?(?:(?!\1).)*&gt;/g)];
  customEmojiMatches.forEach(match => {
    const animated = !!match[2]; // 'a' means animated
    const emojiId = match[4];
    const emojiName = match[3];
    if (emojiId) {
      const emojiExt = (animated && animationsCookie === 1) ? 'gif' : 'png';
      cacheCustomEmoji(emojiId, emojiName, animated);
      result = result.replace(match[0], `<img src="/imageProxy/emoji/${emojiId}.${emojiExt}" width="20" height="20" style="width: 1.25em; height: 1.25em; vertical-align: -0.2em;" alt="emoji" onerror="this.style.display='none'">`);
    }
  });
  
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
  const whiteThemeCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('whiteThemeCookie='))?.split('=')[1];

  // Apply theme colors: 1=light, otherwise dark/amoled
  let embedHead = "#ffffff";
  let embedText = "#dcddde";
  if (whiteThemeCookie == 1) {
    embedHead = "#000000";
    embedText = "#000000";
  }

  if (!embeds || embeds.length === 0) {
    return '';
  }
  
  let embedsHtml = '';
  
  embeds.forEach(embed => {
    let embedHtml = embed_template;
    
    // Set embed color (default to #202225 if not present)
    const embedColor = embed.color ? `#${embed.color.toString(16).padStart(6, '0')}` : '#202225';
    embedHtml = strReplace(embedHtml, '{$EMBED_COLOR}', embedColor);
    
    // Process embed author
    let authorHtml = '';
    if (embed.author) {
      // Create the author text span
      let content = `<span style="font-size: 14px; font-weight: 600; color: #${embedHead};">${escape(normalizeWeirdUnicode(embed.author.name))}</span>`;
      
      // If URL exists, wrap the content in an anchor tag
      if (embed.author.url) {
        authorHtml = `<a href="${escape(embed.author.url)}" target="_blank" style="text-decoration: none; color: inherit;">${content}</a>`;
      } else {
        authorHtml = content;
      }
      
      // REMOVED: authorHtml += '</div>'; (This was the bug closing the container early)
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_AUTHOR}', authorHtml);
    
    // Process embed title
    let titleHtml = '';
    if (embed.title) {
      titleHtml = `<div style="font-size: 16px; font-weight: 600; color: #ffffff; margin-bottom: 8px;">`;
      if (embed.url) {
        titleHtml += `<a href="${escape(embed.url)}" target="_blank" style="color: #00b0f4; text-decoration: none;">${escape(normalizeWeirdUnicode(embed.title))}</a>`;
      } else {
        titleHtml += escape(normalizeWeirdUnicode(embed.title));
      }
      titleHtml += '</div>';
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_TITLE}', titleHtml);
    
    // Process embed description with emoji support (#11)
    let descriptionHtml = '';
    if (embed.description) {
      const renderedMarkdown = renderDiscordMarkdown(embed.description);
      const withEmoji = processEmojiInHTML(renderedMarkdown, imagesCookie, animationsCookie);
      descriptionHtml = `<div style="font-size: 14px; color: #${embedText}; margin-bottom: 8px; white-space: pre-wrap;">${withEmoji}</div>`;
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_DESCRIPTION}', descriptionHtml);
    
    // Process embed fields with emoji support (#11)
    let fieldsHtml = '';
    if (embed.fields && embed.fields.length > 0)
    {
      fieldsHtml = '<table width="100%" cellpadding="2" cellspacing="0" style="margin-bottom: 8px;">';
      let rowOpen = false;
      let inlineCount = 0;
      embed.fields.forEach((field, i) => {
        if (!field.inline) {
          if (rowOpen) { fieldsHtml += '</tr>'; rowOpen = false; inlineCount = 0; }
          fieldsHtml += '<tr><td colspan="3" style="padding-bottom: 4px;">';
          fieldsHtml += `<div style="font-size: 14px; font-weight: 600; color: #${embedHead}; margin-bottom: 4px;">${escape(normalizeWeirdUnicode(field.name))}</div>`;
          const renderedValue = renderDiscordMarkdown(field.value);
          fieldsHtml += `<div style="font-size: 14px; color: #${embedText}; white-space: pre-wrap;">${processEmojiInHTML(renderedValue, imagesCookie, animationsCookie)}</div>`;
          fieldsHtml += '</td></tr>';
        } else {
          if (!rowOpen) { fieldsHtml += '<tr>'; rowOpen = true; inlineCount = 0; }
          fieldsHtml += '<td valign="top" style="padding-bottom: 4px; padding-right: 4px;">';
          fieldsHtml += `<div style="font-size: 14px; font-weight: 600; color: #${embedHead}; margin-bottom: 4px;">${escape(normalizeWeirdUnicode(field.name))}</div>`;
          const renderedValue = renderDiscordMarkdown(field.value);
          fieldsHtml += `<div style="font-size: 14px; color: #${embedText}; white-space: pre-wrap;">${processEmojiInHTML(renderedValue, imagesCookie, animationsCookie)}</div>`;
          fieldsHtml += '</td>';
          inlineCount++;
          const nextField = embed.fields[i + 1];
          if (inlineCount >= 3 || !nextField || !nextField.inline) {
            fieldsHtml += '</tr>';
            rowOpen = false;
            inlineCount = 0;
          }
        }
      });
      if (rowOpen) { fieldsHtml += '</tr>'; }
      fieldsHtml += '</table>';
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_FIELDS}', fieldsHtml);
    
    // Process embed image (#29 - restore image rendering)
    let imageHtml = '';
    if (embed.image && imagesCookie === 1) {
      const imageUrl = embed.image.url || embed.image.proxyURL;
      // Route through imageProxy to convert to GIF format
      const encodedImageUrl = Buffer.from(imageUrl).toString('base64');
      const proxyUrl = `/imageProxy/external/${encodedImageUrl}`;
      imageHtml = `<div style="margin-top: 8px;"><img src="${escape(proxyUrl)}" style="max-width: 256px; max-height: 200px; border-radius: 4px;" alt="Embed image"></div>`;
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_IMAGE}', imageHtml);
    
    // Process embed thumbnail (#29 - restore thumbnail rendering)
    // Thumbnail should be positioned BEFORE title/description so it floats to top-right
    let thumbnailHtml = '';
    if (embed.thumbnail && imagesCookie === 1) {
      const thumbnailUrl = embed.thumbnail.url || embed.thumbnail.proxyURL;
      // Route through imageProxy to convert to GIF format
      const encodedThumbnailUrl = Buffer.from(thumbnailUrl).toString('base64');
      const proxyUrl = `/imageProxy/external/${encodedThumbnailUrl}`;
      thumbnailHtml = `<div style="float: right; margin-left: 12px; margin-bottom: 8px;"><img src="${escape(proxyUrl)}" style="max-width: 80px; max-height: 80px; border-radius: 4px;" alt="Thumbnail"></div>`;
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_THUMBNAIL}', thumbnailHtml);
    
    // Process embed footer
    let footerHtml = '';
    if (embed.footer || embed.timestamp) {
      footerHtml = '<div style="display: flex; align-items: center; margin-top: 8px; font-size: 12px; color: #72767d;">';
      if (embed.footer) {
        footerHtml += `<span>${escape(normalizeWeirdUnicode(embed.footer.text))}</span>`;
      }
      if (embed.timestamp) {
        if (embed.footer) {
          footerHtml += '<span style="margin: 0 4px;">•</span>';
        }
        const date = new Date(embed.timestamp);
        // Format with timezone - returns just time for today, "Yesterday at time" for yesterday, or "date, time" for older
        const formattedDate = formatDateWithTimezone(date, clientTimezone);
        footerHtml += `<span>${formattedDate}</span>`;
      }
      footerHtml += '</div>';
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_FOOTER}', footerHtml);
    
    // Margin right wrapper
    embedsHtml += `<div style="margin-right: 8px;">${embedHtml}</div>`;
  });
  
  return embedsHtml;
}

module.exports = {
  processEmbeds
};
