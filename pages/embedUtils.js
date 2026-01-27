/**
 * Utility module for processing Discord embeds
 * Shared between channel.js and channel_reply.js
 */

const escape = require('escape-html');
const md = require('markdown-it')({ breaks: true, linkify: true });
const { renderDiscordMarkdown } = require('./discordMarkdown');
const fs = require('fs');
const HTMLMinifier = require('@bhavingajjar/html-minify');
const minifier = new HTMLMinifier();

const embed_template = minifier.htmlMinify(fs.readFileSync('pages/templates/message/embed.html', 'utf-8'));

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || "");
}

/**
 * Process Discord embeds into HTML
 * @param {Array} embeds - Array of Discord embed objects
 * @param {number} imagesCookie - Cookie value indicating if images should be displayed (1 = yes, 0 = no)
 * @returns {string} HTML string representing all embeds
 */
function processEmbeds(embeds, imagesCookie) {
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
      authorHtml = '<div style="display: flex; align-items: center; margin-bottom: 8px;">';
      if (embed.author.iconURL && imagesCookie == 1) {
        authorHtml += `<img src="/imageProxy/${embed.author.iconURL.replace(/^(.*?)(\d+)/, '$2')}" style="width: 24px; height: 24px; border-radius: 50%; margin-right: 8px;" alt="author icon">`;
      }
      authorHtml += `<span style="font-size: 14px; font-weight: 600; color: #ffffff;">${escape(embed.author.name)}</span>`;
      if (embed.author.url) {
        authorHtml = `<a href="${escape(embed.author.url)}" target="_blank" style="text-decoration: none; color: inherit;">${authorHtml}</a>`;
      }
      authorHtml += '</div>';
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_AUTHOR}', authorHtml);
    
    // Process embed title
    let titleHtml = '';
    if (embed.title) {
      titleHtml = `<div style="font-size: 16px; font-weight: 600; color: #ffffff; margin-bottom: 8px;">`;
      if (embed.url) {
        titleHtml += `<a href="${escape(embed.url)}" target="_blank" style="color: #00b0f4; text-decoration: none;">${escape(embed.title)}</a>`;
      } else {
        titleHtml += escape(embed.title);
      }
      titleHtml += '</div>';
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_TITLE}', titleHtml);
    
    // Process embed description
    let descriptionHtml = '';
    if (embed.description) {
      descriptionHtml = `<div style="font-size: 14px; color: #dcddde; margin-bottom: 8px; white-space: pre-wrap;">${renderDiscordMarkdown(embed.description)}</div>`;
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_DESCRIPTION}', descriptionHtml);
    
    // Process embed fields
    let fieldsHtml = '';
    if (embed.fields && embed.fields.length > 0) {
      // Discord allows up to 3 inline fields per row with proper spacing
      fieldsHtml = '<div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 8px;">';
      embed.fields.forEach(field => {
        const fieldStyle = field.inline ? 'grid-column: span 1;' : 'grid-column: 1 / -1;';
        fieldsHtml += `<div style="${fieldStyle}">`;
        fieldsHtml += `<div style="font-size: 14px; font-weight: 600; color: #ffffff; margin-bottom: 4px;">${escape(field.name)}</div>`;
        fieldsHtml += `<div style="font-size: 14px; color: #dcddde; white-space: pre-wrap;">${renderDiscordMarkdown(field.value)}</div>`;
        fieldsHtml += '</div>';
      });
      fieldsHtml += '</div>';
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_FIELDS}', fieldsHtml);
    
    // Process embed image
    let imageHtml = '';
    if (embed.image && embed.image.url && imagesCookie == 1) {
      imageHtml = `<div style="margin-top: 16px;"><a href="${escape(embed.image.url)}" target="_blank"><img src="/imageProxy/${embed.image.url.replace(/^(.*?)(\d+)/, '$2')}" style="max-width: 100%; border-radius: 4px;" alt="embed image"></a></div>`;
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_IMAGE}', imageHtml);
    
    // Process embed thumbnail
    let thumbnailHtml = '';
    if (embed.thumbnail && embed.thumbnail.url && imagesCookie == 1) {
      thumbnailHtml = `<div style="float: right; max-width: 80px; margin-left: 16px;"><img src="/imageProxy/${embed.thumbnail.url.replace(/^(.*?)(\d+)/, '$2')}" style="max-width: 100%; border-radius: 4px;" alt="thumbnail"></div>`;
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_THUMBNAIL}', thumbnailHtml);
    
    // Process embed footer
    let footerHtml = '';
    if (embed.footer || embed.timestamp) {
      footerHtml = '<div style="display: flex; align-items: center; margin-top: 8px; font-size: 12px; color: #72767d;">';
      if (embed.footer) {
        if (embed.footer.iconURL && imagesCookie == 1) {
          footerHtml += `<img src="/imageProxy/${embed.footer.iconURL.replace(/^(.*?)(\d+)/, '$2')}" style="width: 20px; height: 20px; border-radius: 50%; margin-right: 8px;" alt="footer icon">`;
        }
        footerHtml += `<span>${escape(embed.footer.text)}</span>`;
      }
      if (embed.timestamp) {
        if (embed.footer) {
          footerHtml += '<span style="margin: 0 4px;">•</span>';
        }
        const date = new Date(embed.timestamp);
        footerHtml += `<span>${date.toLocaleString('en-US')}</span>`;
      }
      footerHtml += '</div>';
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_FOOTER}', footerHtml);
    
    embedsHtml += embedHtml;
  });
  
  return embedsHtml;
}

module.exports = {
  processEmbeds
};
