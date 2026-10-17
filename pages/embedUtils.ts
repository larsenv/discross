'use strict';
const escape = require('escape-html');
const { renderDiscordMarkdown } = require('./discordMarkdown');
const { formatDateWithTimezone } = require('../src/timezoneUtils');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const { processUnicodeEmojiInText, cacheCustomEmoji } = require('./emojiUtils');
const { renderTemplate, getTemplate, render } = require('./utils');
const { renderMosaic, mosaicImage } = require('./mosaicUtils');

const embed_template = getTemplate('embed', 'message');

/**
 * Encode an external file URL for use with the /fileProxy/external/ route.
 */
function proxyExternalFileUrl(url) {
    if (!url || typeof url !== 'string') return url;
    if (
        /^https?:\/\/(?:www\.)?(transfer\.archivete\.am|transfer\.notkiska\.pw|x0\.at)\//i.test(url)
    ) {
        return `/fileProxy/external/${Buffer.from(url).toString('base64')}`;
    }
    return url;
}

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
            render('channel/emoji-custom', {
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
 * Icon URL of an embed author or footer. discord.js embeds expose `iconURL`;
 * raw API payloads (e.g. from search results) use `icon_url`.
 */
function embedIconUrl(part) {
    return part ? part.iconURL || part.icon_url || part.proxyIconURL || part.proxy_icon_url : null;
}

/** URL of an embed image/thumbnail, from either discord.js or raw API shape. */
function embedMediaUrl(media) {
    return media ? media.url || media.proxyURL || media.proxy_url || null : null;
}

/** Embed type ('rich', 'video', 'image', 'article', ...), from either shape. */
function embedType(embed) {
    return embed?.data?.type ?? embed?.type ?? 'rich';
}

/**
 * Discord merges consecutive embeds that share a `url` into a single embed
 * whose images form a mosaic (this is how multi-image tweets and some bots'
 * galleries render). Up to four images are kept, like the official client.
 */
function mergeImageGalleries(embeds) {
    const merged = [];
    for (const embed of embeds) {
        if (!embed) continue;
        const prev = merged[merged.length - 1];
        const image = embedMediaUrl(embed.image);
        if (prev && embed.url && prev.url === embed.url && image && !prev.isVideo) {
            const gallery = prev.images || (prev.image ? [prev.image] : []);
            if (gallery.length < 4) gallery.push(embed.image);
            prev.images = gallery;
            continue;
        }
        merged.push({ ...plainEmbed(embed) });
    }
    return merged;
}

/**
 * Copies the fields we render off a discord.js Embed (whose properties are
 * getters and do not survive object spread) or a raw API embed.
 */
function plainEmbed(embed) {
    return {
        type: embedType(embed),
        color: embed.color,
        provider: embed.provider,
        author: embed.author,
        title: embed.title,
        url: embed.url,
        description: embed.description,
        fields: embed.fields,
        image: embed.image,
        images: embed.images,
        thumbnail: embed.thumbnail,
        video: embed.video,
        footer: embed.footer,
        timestamp: embed.timestamp,
        isVideo: embed.isVideo,
        spoiler: embed.spoiler,
    };
}

/** Formats an embed footer timestamp the way Discord does ("Today at 4:20 PM"). */
function formatEmbedTimestamp(timestamp, clientTimezone) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    const formatted = formatDateWithTimezone(date, clientTimezone);
    return /,|Yesterday/.test(formatted) ? formatted : `Today at ${formatted}`;
}

/** Renders an embed image, wrapped as a spoiler and/or with a play button. */
function renderEmbedImage(url, { linkUrl, isVideo, spoiler }) {
    const proxied = escape(proxyExternalImageUrl(url));
    if (spoiler) {
        return render('channel/spoiler-image', { IMAGE_URL: proxied }).replace(
            /^\s*<br\s*\/?>/i,
            ''
        );
    }
    return render('embed/image', {
        URL: proxied,
        LINK: linkUrl ? escape(linkUrl) : `${proxied}?full=1`,
        CLASS: 'embed-image',
        PLAY: isVideo ? getTemplate('play-button', 'embed') : '',
    });
}

/** Lays out merged embed images with the same mosaic as attachments. */
function renderEmbedGallery(images, spoiler) {
    return renderMosaic(
        images
            .map(embedMediaUrl)
            .filter(Boolean)
            .map((url) => mosaicImage(escape(proxyExternalImageUrl(url)), !!spoiler))
    );
}

/**
 * Process Discord embeds into HTML, mirroring the layout of Discord's client:
 * provider, author, title, description and fields in the main column with the
 * thumbnail beside them, then the large image (or image mosaic) and footer.
 * @param {Array} embeds - Array of Discord embed objects
 * @param {number} imagesCookie - Cookie value indicating if images should be displayed (1 = yes, 0 = no)
 * @param {number} animationsCookie - Cookie value for animation setting (default 1)
 * @param {string|null} clientTimezone - User's timezone for date formatting
 * @returns {string} HTML string representing all embeds
 */
function processEmbeds(req, embeds, imagesCookie, animationsCookie = 1, clientTimezone = null) {
    if (!embeds || embeds.length === 0) {
        return '';
    }

    const embedBarColor = '#808080';
    const markdown = (text) =>
        processEmojiInHTML(
            renderDiscordMarkdown(text, { barColor: embedBarColor, timezone: clientTimezone }),
            imagesCookie,
            animationsCookie
        );
    const showImages = imagesCookie === 1;

    const embedsHtml = mergeImageGalleries(embeds)
        .map((embed) => {
            // Discord paints the bar only when the embed sets a colour; otherwise
            // the theme's neutral bar (see .embed-color-bar) shows through.
            let barStyle = '';
            if (embed.color !== null && embed.color !== undefined) {
                let embedColor = null;
                if (typeof embed.color === 'number') {
                    embedColor = `#${embed.color.toString(16).padStart(6, '0')}`;
                } else if (
                    typeof embed.color === 'string' &&
                    /^#?[0-9a-f]{3,8}$/i.test(embed.color)
                ) {
                    embedColor = embed.color.startsWith('#') ? embed.color : `#${embed.color}`;
                }
                if (embedColor) barStyle = ` style="background-color: ${embedColor};"`;
            }

            // Provider (e.g. "YouTube"), shown above the author like Discord
            const providerName = embed.provider?.name
                ? escape(normalizeWeirdUnicode(embed.provider.name))
                : '';
            const providerHtml = providerName
                ? render('embed/provider', {
                      CONTENT: embed.provider.url
                          ? render('embed/author-link', {
                                URL: escape(proxyExternalFileUrl(embed.provider.url)),
                                CONTENT: providerName,
                            })
                          : providerName,
                  })
                : '';

            // Author
            const authorName = embed.author?.name
                ? escape(normalizeWeirdUnicode(embed.author.name))
                : '';
            const authorIconUrl = embedIconUrl(embed.author);
            const authorHtml = authorName
                ? render('embed/author-row', {
                      ICON:
                          authorIconUrl && showImages
                              ? render('embed/author-icon', {
                                    URL: escape(proxyExternalImageUrl(authorIconUrl)),
                                })
                              : '',
                      CONTENT: embed.author.url
                          ? render('embed/author-link', {
                                URL: escape(proxyExternalFileUrl(embed.author.url)),
                                CONTENT: authorName,
                            })
                          : authorName,
                  })
                : '';

            // Title: Discord renders inline markdown in titles, and colours the
            // title as a link only when the embed has a URL.
            const titleMarkup = embed.title ? markdown(normalizeWeirdUnicode(embed.title)) : '';
            const titleHtml = titleMarkup
                ? render('embed/title', {
                      CONTENT: embed.url
                          ? render('embed/title-link', {
                                URL: escape(proxyExternalFileUrl(embed.url)),
                                CONTENT: titleMarkup,
                            })
                          : titleMarkup,
                  })
                : '';

            const descriptionHtml = embed.description
                ? render('embed/description', { CONTENT: markdown(embed.description) })
                : '';

            const hasThumbnail = !!(embedMediaUrl(embed.thumbnail) && showImages);

            // Fields: up to three inline fields share a row (two when a
            // thumbnail takes up the right-hand column), like Discord's grid.
            const fieldsHtml = (() => {
                const fields = (embed.fields || []).filter((f) => f && (f.name || f.value));
                if (fields.length === 0) return '';
                const maxInline = hasThumbnail ? 2 : 3;
                const rows = [];
                for (const field of fields) {
                    const cellHtml = render('embed/field', {
                        NAME: markdown(normalizeWeirdUnicode(field.name || '')),
                        VALUE: markdown(field.value || ''),
                    });
                    const last = rows[rows.length - 1];
                    if (field.inline && last?.inline && last.cells.length < maxInline) {
                        last.cells.push(cellHtml);
                    } else {
                        rows.push({ inline: !!field.inline, cells: [cellHtml] });
                    }
                }
                return render('embed/fields', {
                    BODY: rows
                        .map((row) => render('embed/field-row', { CELLS: row.cells.join('') }))
                        .join(''),
                });
            })();

            // Large image, or Discord's mosaic when several embeds were merged.
            const imageUrl = embedMediaUrl(embed.image);
            let imageHtml = '';
            if (showImages && embed.images?.length > 1) {
                imageHtml = render('embed/media', {
                    CONTENT: renderEmbedGallery(embed.images, embed.spoiler),
                });
            } else if (showImages && imageUrl) {
                imageHtml = render('embed/media', {
                    CONTENT: renderEmbedImage(imageUrl, {
                        linkUrl:
                            embed.isVideo && embed.url ? proxyExternalFileUrl(embed.url) : null,
                        isVideo: embed.isVideo,
                        spoiler: embed.spoiler,
                    }),
                });
            }

            const thumbnailHtml = hasThumbnail
                ? render('embed/thumbnail', {
                      URL: escape(proxyExternalImageUrl(embedMediaUrl(embed.thumbnail))),
                  })
                : '';

            // Footer
            const footerHtml = (() => {
                const footerTextRaw = embed.footer?.text;
                const timestamp = embed.timestamp
                    ? formatEmbedTimestamp(embed.timestamp, clientTimezone)
                    : '';
                if (!footerTextRaw && !timestamp) return '';
                const footerIconUrl = embedIconUrl(embed.footer);
                return render('embed/footer', {
                    FOOTER_ICON:
                        footerIconUrl && showImages && footerTextRaw
                            ? render('embed/footer-icon', {
                                  URL: escape(proxyExternalImageUrl(footerIconUrl)),
                              })
                            : '',
                    FOOTER_TEXT: footerTextRaw
                        ? render('embed/footer-text', {
                              CONTENT: processEmojiInHTML(
                                  escape(normalizeWeirdUnicode(footerTextRaw)),
                                  imagesCookie,
                                  animationsCookie
                              ),
                          })
                        : '',
                    SEPARATOR:
                        footerTextRaw && timestamp ? getTemplate('footer-separator', 'embed') : '',
                    TIMESTAMP: timestamp ? render('embed/footer-text', { CONTENT: timestamp }) : '',
                });
            })();

            const mainHtml = providerHtml + authorHtml + titleHtml + descriptionHtml + fieldsHtml;
            if (!mainHtml && !imageHtml && !thumbnailHtml && !footerHtml) return '';

            const embedHtml = renderTemplate(embed_template, {
                '{$BAR_STYLE}': barStyle,
                '{$EMBED_MAIN}': mainHtml ? render('embed/main', { CONTENT: mainHtml }) : '',
                '{$EMBED_IMAGE}': imageHtml,
                '{$EMBED_THUMBNAIL}': thumbnailHtml,
                '{$EMBED_FOOTER}': footerHtml,
                '{$VIDEO_CLASS}': embed.isVideo ? ' video-embed' : '',
            });

            return render('embed/wrapper', { CONTENT: embedHtml });
        })
        .join('');

    return embedsHtml;
}

module.exports = {
    processEmbeds,
    processEmojiInHTML,
    proxyExternalImageUrl,
    proxyExternalFileUrl,
    embedMediaUrl,
    embedType,
    plainEmbed,
};
