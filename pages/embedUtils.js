const escape = require('escape-html');
const md = require('markdown-it')({ breaks: true, linkify: true });
const { renderDiscordMarkdown } = require('./discordMarkdown');
const { formatDateWithTimezone } = require('../timezoneUtils');
const fs = require('fs');
const HTMLMinifier = require('@bhavingajjar/html-minify');
const minifier = new HTMLMinifier();

const embed_template = minifier.htmlMinify(fs.readFileSync('pages/templates/message/embed.html', 'utf-8'));

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
  
  // Process custom emoji (HTML escaped format from markdown)
  const customEmojiMatches = [...result.matchAll(/&lt;(:)?(?:(a):)?(\w{2,32}):(\d{17,19})?(?:(?!\1).)*&gt;/g)];
  customEmojiMatches.forEach(match => {
    const ext = match[2] ? "gif" : "png"; // 'a' means animated
    const emojiId = match[4];
    if (emojiId) {
      result = result.replace(match[0], `<img src="/imageProxy/emoji/${emojiId}.${ext}" style="width: 1.25em; height: 1.25em; vertical-align: -0.2em;" alt="emoji" onerror="this.style.display='none'">`);
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
function processEmbeds(embeds, imagesCookie, animationsCookie = 1, clientTimezone = null) {
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
      let content = `<span style="font-size: 14px; font-weight: 600; color: #ffffff;">${escape(embed.author.name)}</span>`;
      
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
      const renderedTitle = renderDiscordMarkdown(embed.title);
      const titleWithEmoji = processEmojiInHTML(renderedTitle, imagesCookie, animationsCookie);
      titleHtml = `<div style="font-size: 16px; font-weight: 600; color: #ffffff; margin-bottom: 8px;">`;
      if (embed.url) {
        titleHtml += `<a href="${escape(embed.url)}" target="_blank" style="color: #00b0f4; text-decoration: none;">${titleWithEmoji}</a>`;
      } else {
        titleHtml += titleWithEmoji;
      }
      titleHtml += '</div>';
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_TITLE}', titleHtml);
    
    // Process embed description with emoji support (#11)
    let descriptionHtml = '';
    if (embed.description) {
      const renderedMarkdown = renderDiscordMarkdown(embed.description);
      const withEmoji = processEmojiInHTML(renderedMarkdown, imagesCookie, animationsCookie);
      descriptionHtml = `<div style="font-size: 14px; color: #dcddde; margin-bottom: 8px; white-space: pre-wrap;">${withEmoji}</div>`;
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_DESCRIPTION}', descriptionHtml);
    
    // Process embed fields with emoji support (#11)
    let fieldsHtml = '';
    if (embed.fields && embed.fields.length > 0) {
      // Discord allows up to 3 inline fields per row with proper spacing
      fieldsHtml = '<div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 8px;">';
      embed.fields.forEach(field => {
        const fieldStyle = field.inline ? 'grid-column: span 1;' : 'grid-column: 1 / -1;';
        fieldsHtml += `<div style="${fieldStyle}">`;
        const renderedName = renderDiscordMarkdown(field.name);
        const nameWithEmoji = processEmojiInHTML(renderedName, imagesCookie, animationsCookie);
        fieldsHtml += `<div style="font-size: 14px; font-weight: 600; color: #ffffff; margin-bottom: 4px;">${nameWithEmoji}</div>`;
        const renderedValue = renderDiscordMarkdown(field.value);
        const valueWithEmoji = processEmojiInHTML(renderedValue, imagesCookie, animationsCookie);
        fieldsHtml += `<div style="font-size: 14px; color: #dcddde; white-space: pre-wrap;">${valueWithEmoji}</div>`;
        fieldsHtml += '</div>';
      });
      fieldsHtml += '</div>';
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_FIELDS}', fieldsHtml);
    
    // Process embed image (#29 - restore image rendering)
    let imageHtml = '';
    if (embed.image && imagesCookie === 1) {
      imageHtml = `<div style="margin-top: 8px;"><img src="${escape(embed.image.url || embed.image.proxyURL)}" style="max-width: 100%; max-height: 300px; border-radius: 4px;" alt="Embed image"></div>`;
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_IMAGE}', imageHtml);
    
    // Process embed thumbnail (#29 - restore thumbnail rendering)
    // Thumbnail should be positioned BEFORE title/description so it floats to top-right
    let thumbnailHtml = '';
    if (embed.thumbnail && imagesCookie === 1) {
      thumbnailHtml = `<div style="float: right; margin-left: 12px; margin-bottom: 8px;"><img src="${escape(embed.thumbnail.url || embed.thumbnail.proxyURL)}" style="max-width: 80px; max-height: 80px; border-radius: 4px;" alt="Thumbnail"></div>`;
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_THUMBNAIL}', thumbnailHtml);
    
    // Process embed footer
    let footerHtml = '';
    if (embed.footer || embed.timestamp) {
      footerHtml = '<div style="display: flex; align-items: center; margin-top: 8px; font-size: 12px; color: #72767d;">';
      if (embed.footer) {
        footerHtml += `<span>${escape(embed.footer.text)}</span>`;
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
