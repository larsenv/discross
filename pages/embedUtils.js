'use strict';
const escape = require('escape-html');
const { renderDiscordMarkdown } = require('./discordMarkdown');
const { formatDateWithTimezone } = require('../timezoneUtils');
const fs = require('fs');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const { processUnicodeEmojiInText, cacheCustomEmoji } = require('./emojiUtils');
const { renderTemplate, parseCookies, getTemplate } = require('./utils.js');

const embed_template = fs.readFileSync('pages/templates/message/embed.html', 'utf-8');

/**
 * Encode an external image URL for use with the /imageProxy/external/ route.
 * @param {string} url - Raw image URL
 * @returns {string} Proxy path ready to embed in HTML
 */
function proxyExternalImageUrl(url) {
    if (url.includes('discross.net') || url.startsWith('/')) return url;
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
        ...withUnicode.matchAll(/&lt;(:)?(?:(a):)?(\w{2,32}):(\d{16,20})?(?:(?!\1).)*&gt;/g),
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
            renderTemplate(getTemplate('emoji_custom', 'channel'), {
                EMOJI_ID: emojiId,
                EXT: emojiExt,
                PX: '20',
                STYLE: 'width: 1.25em; height: 1.25em; vertical-align: -0.2em;',
            })
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
    const embedBarColor = '#808080';

    if (!embeds || embeds.length === 0) {
        return '';
    }

    const embedsHtml = embeds
        .map((embed) => {
            // Set embed color (default to #202225 if not present)
            let embedColor = '#202225';
            if (embed.color !== null && embed.color !== undefined) {
                if (typeof embed.color === 'number') {
                    embedColor = `#${embed.color.toString(16).padStart(6, '0')}`;
                } else if (typeof embed.color === 'string') {
                    embedColor = embed.color.startsWith('#') ? embed.color : `#${embed.color}`;
                }
            }

            // Process embed author
            const authorContent = embed.author
                ? renderTemplate(getTemplate('author', 'embed'), {
                      COLOR: embedHead,
                      NAME: escape(normalizeWeirdUnicode(embed.author.name)),
                  })
                : '';
            const authorHtml =
                embed.author && authorContent
                    ? embed.author.url
                        ? renderTemplate(getTemplate('author_link', 'embed'), {
                              URL: escape(embed.author.url),
                              CONTENT: authorContent,
                          })
                        : authorContent
                    : '';

            // Process embed title
            const titleContent = embed.title
                ? embed.url
                    ? renderTemplate(getTemplate('title_link', 'embed'), {
                          URL: escape(embed.url),
                          CONTENT: escape(normalizeWeirdUnicode(embed.title)),
                      })
                    : escape(normalizeWeirdUnicode(embed.title))
                : '';
            const titleHtml = titleContent
                ? renderTemplate(getTemplate('title', 'embed'), { CONTENT: titleContent })
                : '';

            // Process embed description with emoji support (#11)
            const processedDescription = embed.description
                ? processEmojiInHTML(
                      renderDiscordMarkdown(embed.description, { barColor: embedBarColor }),
                      imagesCookie,
                      animationsCookie
                  )
                : null;
            const descriptionHtml = processedDescription
                ? renderTemplate(getTemplate('description', 'embed'), {
                      COLOR: embedText,
                      CONTENT: processedDescription,
                  })
                : '';

            // Process embed fields with emoji support (#11)
            const fieldsHtml = (() => {
                if (!embed.fields || embed.fields.length === 0) return '';
                const { body: tableBody, rowOpen: lastRowOpen } = embed.fields.reduce(
                    (state, field, i) => {
                        let { body, rowOpen, inlineCount } = state;
                        const renderedName = renderDiscordMarkdown(
                            normalizeWeirdUnicode(field.name),
                            {
                                barColor: embedBarColor,
                            }
                        );
                        const renderedValue = processEmojiInHTML(
                            renderDiscordMarkdown(field.value, { barColor: embedBarColor }),
                            imagesCookie,
                            animationsCookie
                        );

                        if (!field.inline) {
                            if (rowOpen) {
                                body += '</tr>';
                                rowOpen = false;
                                inlineCount = 0;
                            }
                            body += renderTemplate(getTemplate('field_block', 'embed'), {
                                HEAD_COLOR: embedHead,
                                NAME: renderedName,
                                TEXT_COLOR: embedText,
                                VALUE: renderedValue,
                            });
                        } else {
                            if (!rowOpen) {
                                body += '<tr>';
                                rowOpen = true;
                                inlineCount = 0;
                            }
                            body += renderTemplate(getTemplate('field_inline', 'embed'), {
                                HEAD_COLOR: embedHead,
                                NAME: renderedName,
                                TEXT_COLOR: embedText,
                                VALUE: renderedValue,
                            });
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
                return renderTemplate(getTemplate('fields_table', 'embed'), {
                    BODY: tableBody + closingTag,
                });
            })();

            // Process embed image (#29 - restore image rendering)
            const imageHtml =
                embed.image && imagesCookie === 1
                    ? renderTemplate(getTemplate('image', 'embed'), {
                          URL: escape(
                              proxyExternalImageUrl(embed.image.url || embed.image.proxyURL)
                          ),
                      })
                    : '';

            // Process embed thumbnail (#29 - restore thumbnail rendering)
            // Thumbnail should be positioned BEFORE title/description so it floats to top-right
            const thumbnailHtml =
                embed.thumbnail && imagesCookie === 1
                    ? renderTemplate(getTemplate('thumbnail', 'embed'), {
                          URL: escape(
                              proxyExternalImageUrl(embed.thumbnail.url || embed.thumbnail.proxyURL)
                          ),
                      })
                    : '';

            // Process embed footer
            const footerHtml = (() => {
                if (!embed.footer && !embed.timestamp) return '';
                const footerIconHtml =
                    embed.footer && embed.footer.icon_url && imagesCookie === 1
                        ? renderTemplate(getTemplate('footer_icon', 'embed'), {
                              URL: proxyExternalImageUrl(embed.footer.icon_url),
                          })
                        : '';
                const footerText = embed.footer
                    ? renderTemplate(getTemplate('footer_text', 'embed'), {
                          CONTENT: escape(normalizeWeirdUnicode(embed.footer.text)),
                      })
                    : '';
                const separator =
                    embed.footer && embed.timestamp ? getTemplate('footer_separator', 'embed') : '';
                const timestamp = embed.timestamp
                    ? renderTemplate(getTemplate('footer_text', 'embed'), {
                          CONTENT: formatDateWithTimezone(
                              new Date(embed.timestamp),
                              clientTimezone
                          ),
                      })
                    : '';
                return renderTemplate(getTemplate('message_footer', 'misc'), {
                    FOOTER_ICON: footerIconHtml,
                    FOOTER_TEXT: footerText,
                    SEPARATOR: separator,
                    TIMESTAMP: timestamp,
                });
            })();

            const embedHtml = renderTemplate(embed_template, {
                '{$EMBED_COLOR}': embedColor,
                '{$EMBED_AUTHOR}': authorHtml,
                '{$EMBED_TITLE}': titleHtml,
                '{$EMBED_DESCRIPTION}': descriptionHtml,
                '{$EMBED_FIELDS}': fieldsHtml,
                '{$EMBED_IMAGE}': imageHtml,
                '{$EMBED_THUMBNAIL}': thumbnailHtml,
                '{$EMBED_FOOTER}': footerHtml,
                '{$VIDEO_CLASS}': embed.isVideo ? ' video-embed' : '',
            });

            // Margin right wrapper
            return renderTemplate(getTemplate('wrapper', 'embed'), { CONTENT: embedHtml });
        })
        .join('');

    return embedsHtml;
}

module.exports = {
    processEmbeds,
};
