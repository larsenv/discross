'use strict';

const escape = require('escape-html');
const he = require('he');
const { PermissionFlagsBits, MessageReferenceType, UserFlags } = require('discord.js');
const { renderDiscordMarkdown } = require('./discordMarkdown');
const { getDisplayName, getMemberColor, ensureMemberData } = require('./memberUtils');
const {
    getClientIP,
    getTimezoneFromIP,
    formatDateWithTimezone,
    formatDateSeparator,
    areDifferentDays,
    formatForwardedTimestamp,
    replaceDiscordTimestamps,
} = require('../timezoneUtils');
const { processEmbeds } = require('./embedUtils');
const { processReactions } = require('./reactionUtils');
const { processPoll } = require('./pollUtils');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const { unicodeToTwemojiCode, cacheCustomEmoji, getSkinToneSelectorHTML } = require('./emojiUtils');
const emojiRegex = require('./twemojiRegex').regex;
const notFound = require('./notFound.js');
const auth = require('../authentication.js');
const { parseUserAgent } = require('./userAgentUtils.js');
const {
    isBotReady,
    parseCookies,
    resolveTheme,
    RANDOM_EMOJIS,
    buildSessionParam,
    buildEmojiToggleUrl,
    getTemplate,
    renderTemplate,
} = require('./utils.js');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FORWARDED_CONTENT_MAX_LENGTH = 100;
const REPLY_CONTENT_MAX_LENGTH = 25;
const MESSAGE_GROUP_TIMEOUT_MS = 420_000; // 7 minutes

const SYSTEM_MESSAGE_TEXT = {
    1: 'added a new member',
    2: 'left',
    3: 'started a call',
    4: 'changed the channel name',
    5: 'changed the channel icon',
    6: 'pinned a message to this channel',
    7: 'welcomed a new member',
    8: 'boosted the server',
    9: 'boosted the server to level 1',
    10: 'boosted the server to level 2',
    11: 'boosted the server to level 3',
    12: 'followed this channel',
    14: 'is no longer eligible for Server Discovery',
    15: 'is eligible for Server Discovery again',
    16: 'is in the Server Discovery grace period',
    17: 'received a final warning for Server Discovery',
    18: 'started a thread',
    21: 'started a thread',
    22: 'sent an invite reminder',
    24: 'flagged a message with AutoMod',
    25: 'purchased a role subscription',
    26: 'upsold a premium interaction',
    27: 'started a stage',
    28: 'ended the stage',
    29: 'became a stage speaker',
    30: 'raised their hand',
    31: 'changed the stage topic',
    32: 'subscribed to a server application premium',
    36: 'enabled raid alert mode',
    37: 'disabled raid alert mode',
    38: 'reported a raid',
    39: 'reported a false alarm',
    44: 'made a purchase',
    46: 'completed a poll',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatFileSize(bytes) {
    if (bytes === 0) return '0.00 Bytes';
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

function removeExistingEndAnchors(html) {
    return html.replace(/<a[^>]*(?:id=['"]end['"]|name=['"]end['"])[^>]*>[\s\S]*?<\/a>/gi, '');
}

function urlMatchesDomain(url, domain) {
    try {
        const { hostname } = new URL(url);
        return hostname === domain || hostname.endsWith('.' + domain);
    } catch {
        return false;
    }
}

function truncateFileName(name) {
    if (name.length <= 30) return name;
    const ext = name.replace(/(.*\.)(.*)$/, '$2');
    const base = name.replace(/(.*\.)(.*)$/, '$1').slice(0, 25);
    return `${base}...${ext}`;
}

function truncateText(text, maxLength) {
    const chars = Array.from(text);
    return chars.length > maxLength ? chars.slice(0, maxLength).join('') + '...' : text;
}

function isSameAuthor(member1, author1, member2, author2) {
    if (member1 && member2) return member1.user.id === member2.user.id;
    if (author1 && author2)
        return author1.id === author2.id && author1.username === author2.username;
    return false;
}

function isNormalMessage(type) {
    return type === 0 || type === 19 || type === 20 || type === 23 || type === 25;
}

// ---------------------------------------------------------------------------
// Rendering Components
// ---------------------------------------------------------------------------

/**
 * Renders emojis in the message text, replacing custom and unicode emojis with image tags.
 *
 * This function performs two main transformations:
 * 1. Unicode Emojis: Replaces raw Unicode characters with Twemoji <img> tags.
 * 2. Custom Emojis: Replaces Discord-formatted emoji strings (<:name:id>) with <img> tags.
 *
 * "Jumbo" logic: If a message consists ONLY of emojis (up to 29), they are rendered larger.
 *
 * @param {string} messagetext - The HTML-escaped text to process.
 * @param {object} item - The Discord message object (used for raw content check).
 * @param {number} imagesCookie - User preference for showing images (1 = enabled).
 * @param {number} animationsCookie - User preference for showing animations (1 = enabled).
 * @returns {string} The text with emojis rendered as HTML <img> tags.
 */

function renderEmojis(messagetext, item, imagesCookie, animationsCookie) {
    // Skip image rendering if user prefers text-only
    if (imagesCookie !== 1) return messagetext;

    // Detect if the message is "Jumboable" (only contains emojis and whitespace)
    const customEmojiRegex = /<a?:.+?:\d{16,20}>/g;
    const customMatches = item.content.match(customEmojiRegex) ?? [];
    const unicodeMatches = item.content.match(emojiRegex) ?? [];
    const totalEmojis = customMatches.length + unicodeMatches.length;
    // Remove all emojis and trim to see if anything else is left
    const stripped = item.content.replace(customEmojiRegex, '').replace(emojiRegex, '').trim();
    // Discord's "jumbo" limit is typically 27-30 emojis. We use 29.
    const isJumbo = stripped.length === 0 && totalEmojis > 0 && totalEmojis <= 29;

    const size = isJumbo ? '2.75em' : '1.375em';
    const px = isJumbo ? 44 : 22;
    // vertical-align: -0.2em; is a common trick to align emojis with text baselines
    const imgStyle = `width: ${size}; height: ${size}; vertical-align: -0.2em;`;

    const tmpl_twemoji = getTemplate('emoji-twemoji', 'channel');
    const tmpl_custom = getTemplate('emoji-custom', 'channel');

    let result = messagetext;

    // 1. Process Unicode emojis (e.g. 😀)
    // We replace the character with a Twemoji GIF hosted locally.
    result = result.replace(emojiRegex, (match) => {
        const code = unicodeToTwemojiCode(match);
        return renderTemplate(tmpl_twemoji, {
            CODE: code,
            PX: px.toString(),
            STYLE: imgStyle,
        });
    });

    // 2. Process Custom Discord emojis (e.g. <:pepe:123456789>)
    // These come in as HTML-escaped sequences (&lt;:...&gt;) because messagetext is already escaped.
    const customMatchesIterator = result.matchAll(
        /&lt;(:)?(?:(a):)?(\w{2,32}):(\d{16,20})?(?:(?!\1).)*&gt;/g
    );
    for (const match of customMatchesIterator) {
        const animated = !!match[2]; // 'a' indicates animation
        const ext = animated && animationsCookie === 1 ? 'gif' : 'png';
        // Cache the emoji metadata in the database for later use (e.g. emoji picker)
        cacheCustomEmoji(match[4], match[3], animated);
        result = result.split(match[0]).join(
            renderTemplate(tmpl_custom, {
                EMOJI_ID: match[4],
                EXT: ext,
                PX: px.toString(),
                STYLE: imgStyle,
            })
        );
    }

    return result;
}

/**
 * Renders message attachments (images, videos, files) into HTML.
 *
 * Images are rendered as <img> tags (wrapped in spoiler tags if necessary).
 * Other files (videos, PDFs, etc.) are rendered as download cards/links.
 *
 * @param {string} messagetext - The current message HTML.
 * @param {object} item - The Discord message object containing attachments.
 * @param {number} imagesCookie - User preference for showing images (1 = enabled).
 * @param {string} tmpl_file_download - The template for file download cards.
 * @returns {string} The HTML with attachments appended to the message text.
 */

function renderAttachments(messagetext, item, imagesCookie, tmpl_file_download) {
    let result = messagetext || '';
    const attachments = item?.attachments;

    if (!attachments) return result;

    const list = attachments.values ? Array.from(attachments.values()) : attachments;

    if (list.length === 0) return result;

    const tmpl_spoiler = getTemplate('spoiler-image', 'channel');
    const tmpl_normal_image = getTemplate('normal-image', 'channel');

    const IMAGE_EXT = /\.(jpg|gif|png|jpeg|avif|svg|webp|tif|tiff)$/i;
    const VIDEO_EXT = /\.(mp4|webm|mov|avi|mkv)$/i;
    const imageData = [];

    for (const attachment of list) {
        if (!attachment) continue;

        const isImage = IMAGE_EXT.test(attachment.name);
        const isVideo = VIDEO_EXT.test(attachment.name);
        const isSpoiler = attachment.name?.toUpperCase().startsWith('SPOILER_');

        // We proxy images to avoid hotlinking issues and to resize them if needed.
        // Files are served via a simple proxy that sets proper download headers.
        const proxyBase = isImage && imagesCookie === 1 ? '/imageProxy/' : '/fileProxy/';
        // Strip the CDN hostname and keep the path (e.g. /attachments/123/456/file.png)
        const url = proxyBase + (attachment.url || '').replace(/^(.*?)(\d+)/, '$2');

        if (isImage && imagesCookie === 1) {
            imageData.push({ url, isSpoiler });
        } else {
            // Render a file download card for non-images or if images are disabled.
            const card = renderTemplate(tmpl_file_download, {
                '{$FILE_NAME}': truncateFileName(attachment.name || 'file'),
                '{$FILE_SIZE}': formatFileSize(attachment.size || 0),
                // Videos are not supported for inline playback yet, so they are just downloads.
                '{$FILE_LINK}': url,
            });
            result = (result ? result + getTemplate('br', 'misc') : '') + card;
        }
    }

    // Append images after the message text and file cards.
    // Images are rendered in a separate loop so they always appear at the bottom.
    if (imageData.length === 1) {
        const data = imageData[0];
        result += data.isSpoiler
            ? renderTemplate(tmpl_spoiler, { IMAGE_URL: data.url })
            : renderTemplate(tmpl_normal_image, { IMAGE_URL: data.url });
    } else if (imageData.length > 1) {
        let galleryContent = '';
        const tmpl_gallery_item = getTemplate('gallery-item', 'channel');
        for (const data of imageData) {
            if (data.isSpoiler) {
                galleryContent += renderTemplate(tmpl_spoiler, { IMAGE_URL: data.url });
            } else {
                galleryContent += renderTemplate(tmpl_gallery_item, { IMAGE_URL: data.url });
            }
        }
        result += renderTemplate(getTemplate('image-gallery', 'channel'), {
            COUNT: imageData.length,
            GALLERY_CONTENT: galleryContent,
        });
    }

    return result;
}

/**
 * Renders message stickers into HTML.
 *
 * If images are enabled, renders the sticker as a 100x100 <img> tag.
 * Otherwise, renders the sticker's name in brackets (e.g. [Sticker: Wave]).
 *
 * @param {string} messagetext - The current message HTML.
 * @param {object} item - The Discord message object containing stickers.
 * @param {number} imagesCookie - User preference for showing images (1 = enabled).
 * @returns {string} The HTML with stickers appended.
 */

function renderStickers(messagetext, item, imagesCookie) {
    let result = messagetext || '';
    const stickers = item?.stickers;
    if (!stickers) return result;

    const list = stickers.values ? Array.from(stickers.values()) : stickers;
    if (list.length === 0) return result;

    const tmpl_sticker = getTemplate('sticker', 'channel');
    const tmpl_sticker_text = getTemplate('sticker-text', 'channel');

    for (const sticker of list) {
        if (!sticker) continue;
        const sep = result ? getTemplate('br', 'misc') : '';
        if (imagesCookie === 1) {
            result += sep + renderTemplate(tmpl_sticker, { STICKER_ID: sticker.id });
        } else {
            result +=
                sep +
                renderTemplate(tmpl_sticker_text, {
                    STICKER_NAME: escape(sticker.name ?? 'Unknown'),
                });
        }
    }

    return result;
}

/**
 * Utility to build a <img> tag for an external image via the image proxy.
 *
 * @param {string} rawUrl - The external image URL.
 * @param {string} alt - Alt text for the image.
 * @param {string} [style] - CSS style for the image tag.
 * @returns {{ proxied: string, tag: string }} The proxied URL and the full HTML tag.
 */
function buildProxiedImageTag(
    rawUrl,
    alt,
    style = 'max-width:256px;max-height:200px;height:auto;'
) {
    if (!rawUrl || typeof rawUrl !== 'string') return { proxied: '', tag: '' };
    const proxied = `/imageProxy/external/${Buffer.from(rawUrl).toString('base64')}`;
    const tag = renderTemplate(getTemplate('image-tag', 'channel'), {
        IMAGE_SRC: proxied,
        CLASS: style,
        IMAGE_ALT: alt,
    });
    return { proxied, tag };
}

/**
 * Either replaces a link in the message text with an image tag or appends the image.
 * This is used for media embeds where we want to "inline" the thumbnail if the URL is present.
 *
 * @param {string} messagetext - The message HTML.
 * @param {string} embedUrl - The URL of the media embed.
 * @param {string} imgHtml - The <img> tag to insert.
 * @returns {string} The updated message HTML.
 */
function replaceOrAppendMedia(messagetext, embedUrl, imgHtml) {
    let result = messagetext || '';
    if (embedUrl) {
        // Look for the URL inside an <a> tag and replace the whole tag with the image.
        const escaped = embedUrl.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
        const escapedEncoded = embedUrl
            .replace(/&/g, '&amp;')
            .replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
        const re = new RegExp(
            `<a\\s+[^>]*href=["'](?:${escaped}|${escapedEncoded})["'][^>]*>[^<]*</a>`,
            'ig'
        );
        if (re.test(result)) return result.replace(re, imgHtml);
    }
    // Fallback: append to the end
    return (result ? result + getTemplate('br', 'misc') : '') + imgHtml;
}

/**
 * Processes and renders message embeds (Tenor, Giphy, YouTube, and rich embeds).
 *
 * Special handling is provided for common GIF and video services to inline them
 * as static (proxied) images for compatibility with older browsers.
 * Other rich embeds are delegated to `processEmbeds`.
 *
 * @param {string} messagetext - The current message HTML.
 * @param {object} item - The Discord message object containing embeds.
 * @param {object} req - The HTTP request object.
 * @param {number} imagesCookie - User preference for images (1 = enabled).
 * @param {number} animationsCookie - User preference for animations (1 = enabled).
 * @param {string} clientTimezone - The user's timezone.
 * @returns {string} The HTML with rendered embeds.
 */
function renderEmbeds(messagetext, item, req, imagesCookie, animationsCookie, clientTimezone) {
    let result = messagetext || '';

    if (!item?.embeds?.length) return result;

    const richEmbeds = [];

    for (const embed of item.embeds) {
        if (!embed) continue;

        // 1. Detect special media providers
        const isTenor =
            (embed.provider?.name === 'Tenor' || urlMatchesDomain(embed.url, 'tenor.com')) &&
            embed.thumbnail?.url;

        const isGiphy =
            (embed.provider?.name === 'GIPHY' || urlMatchesDomain(embed.url, 'giphy.com')) &&
            (embed.thumbnail?.url || embed.image?.url);

        const isYouTube =
            embed.provider?.name === 'YouTube' ||
            urlMatchesDomain(embed.url, 'youtube.com') ||
            urlMatchesDomain(embed.url, 'youtu.be');

        const isVimeo =
            embed.provider?.name === 'Vimeo' || urlMatchesDomain(embed.url, 'vimeo.com');

        const isOtherVideo =
            ['Streamable', 'Twitch', 'TikTok', 'Instagram', 'Twitter', 'Twitter (X)', 'X'].includes(
                embed.provider?.name
            ) ||
            urlMatchesDomain(embed.url, 'streamable.com') ||
            urlMatchesDomain(embed.url, 'twitch.tv') ||
            urlMatchesDomain(embed.url, 'clips.twitch.tv') ||
            urlMatchesDomain(embed.url, 'tiktok.com') ||
            urlMatchesDomain(embed.url, 'vxtiktok.com') ||
            urlMatchesDomain(embed.url, 'instagram.com') ||
            urlMatchesDomain(embed.url, 'ddinstagram.com') ||
            urlMatchesDomain(embed.url, 'twitter.com') ||
            urlMatchesDomain(embed.url, 'x.com') ||
            urlMatchesDomain(embed.url, 'fxtwitter.com') ||
            urlMatchesDomain(embed.url, 'vxtwitter.com');

        // If images are disabled, we only show text-based rich embeds (including YouTube meta).
        if (imagesCookie !== 1) {
            if (!isTenor && !isGiphy) {
                if (isYouTube) {
                    // YouTube embeds get a red sidebar for flair.
                    richEmbeds.push({
                        color: 0xfd001b,
                        author: embed.author,
                        title: embed.title,
                        url: embed.url,
                        description: null,
                        fields: embed.fields,
                        image: embed.image,
                        thumbnail: embed.thumbnail,
                        footer: embed.footer,
                        timestamp: embed.timestamp,
                        data: embed.data,
                        isVideo: true,
                    });
                } else if (isVimeo || isOtherVideo) {
                    richEmbeds.push({
                        author: embed.author,
                        title: embed.title,
                        url: embed.url,
                        description: null,
                        fields: embed.fields,
                        image: embed.image,
                        thumbnail: embed.thumbnail,
                        footer: embed.footer,
                        timestamp: embed.timestamp,
                        data: embed.data,
                        isVideo: true,
                    });
                } else {
                    richEmbeds.push(embed);
                }
            }

            continue;
        }

        // 2. Inline rendering for Tenor/Giphy (Static image proxy)
        if (isTenor) {
            result = replaceOrAppendMedia(
                result,
                embed.url,
                buildProxiedImageTag(embed.thumbnail.url, 'Tenor GIF').tag
            );
        } else if (isGiphy) {
            const rawUrl = embed.image?.url ?? embed.thumbnail?.url;

            if (rawUrl)
                result = replaceOrAppendMedia(
                    result,
                    embed.url,
                    buildProxiedImageTag(rawUrl, 'GIPHY GIF').tag
                );
        } else if (isYouTube) {
            // YouTube is rendered as a rich embed but with its thumbnail promoted to a large image.
            richEmbeds.push({
                color: 0xfd001b,
                author: embed.author,
                title: embed.title,
                url: embed.url,
                description: null,
                fields: embed.fields,
                image: embed.image ?? embed.thumbnail,
                thumbnail: null,
                footer: embed.footer,
                timestamp: embed.timestamp,
                data: embed.data,
                isVideo: true,
            });
        } else if (isVimeo || isOtherVideo) {
            // Video platforms are rendered as rich embeds but with thumbnails promoted to large images.
            richEmbeds.push({
                author: embed.author,
                title: embed.title,
                url: embed.url,
                description: null,
                fields: embed.fields,
                image: embed.image ?? embed.thumbnail,
                thumbnail: null,
                footer: embed.footer,
                timestamp: embed.timestamp,
                data: embed.data,
                isVideo: true,
            });
        } else if (embed.data?.type === 'poll_result') {
            // Discord native poll results are sent as special embeds.
            result =
                (result ? result + getTemplate('br', 'misc') : '') + renderPollResultEmbed(embed);
        } else if (embed.data?.type === 'image' || embed.data?.type === 'gifv') {
            // Raw image/GIFV embeds are inlined directly.
            const rawUrl = embed.thumbnail?.url ?? embed.image?.url;

            if (rawUrl)
                result = replaceOrAppendMedia(
                    result,
                    embed.url,
                    buildProxiedImageTag(rawUrl, 'Image').tag
                );
        } else {
            // Everything else goes to the general-purpose rich embed processor.
            richEmbeds.push(embed);
        }
    }

    // Process all collected rich embeds at once.
    if (richEmbeds.length > 0) {
        result += processEmbeds(req, richEmbeds, imagesCookie, animationsCookie, clientTimezone);
    }

    return result;
}

/**
 * Detects Discord event links in message content and renders them as embeds.
 *
 * @param {string} messagetext - The current message HTML.
 * @param {object} item - The Discord message object.
 * @param {object} bot - The bot instance.
 * @param {number} imagesCookie - User preference for images.
 * @param {string} clientTimezone - The user's timezone.
 * @returns {Promise<string>} The updated message HTML.
 */
async function renderDiscordEvents(messagetext, item, bot, imagesCookie, clientTimezone) {
    let result = messagetext || '';
    if (!item?.content) return result;

    const eventRegex = /https?:\/\/(?:www\.)?discord(?:app)?\.com\/events\/(\d+)\/(\d+)/gi;
    const matches = [...item.content.matchAll(eventRegex)];

    if (matches.length === 0) return result;

    const processedLinks = new Set();

    for (const match of matches) {
        const link = match[0];
        if (processedLinks.has(link)) continue;
        processedLinks.add(link);

        const guildId = match[1];
        const eventId = match[2];

        try {
            const guild = bot.client.guilds.cache.get(guildId);
            if (!guild) continue;

            const event = await guild.scheduledEvents.fetch(eventId).catch(() => null);
            if (!event) continue;

            const iconUrl = guild.iconURL({ size: 128 });
            const guildIconHtml =
                iconUrl && imagesCookie === 1
                    ? renderTemplate(getTemplate('event-guild-icon', 'embed'), {
                          ICON_URL: `/imageProxy/external/${Buffer.from(iconUrl).toString('base64')}`,
                      })
                    : renderTemplate(getTemplate('event-guild-icon-none', 'embed'), {});

            let locationHtml = '';
            if (event.entityMetadata?.location) {
                locationHtml = renderTemplate(getTemplate('event-location-external', 'embed'), {
                    LOCATION: escape(event.entityMetadata.location),
                });
            } else if (event.channelId) {
                const chan = bot.client.channels.cache.get(event.channelId);
                locationHtml = renderTemplate(getTemplate('event-location-voice', 'embed'), {
                    CHANNEL_NAME: escape(chan?.name || 'Voice Channel'),
                });
            }

            const descriptionHtml = event.description
                ? renderTemplate(getTemplate('event-description', 'embed'), {
                      DESCRIPTION: renderDiscordMarkdown(event.description),
                  })
                : '';

            const interestedHtml = renderTemplate(getTemplate('event-interested-count', 'embed'), {
                COUNT: (event.userCount || 0).toLocaleString(),
            });

            const coverUrl = event.coverImageURL({ size: 512 });
            const imageHtml =
                coverUrl && imagesCookie === 1
                    ? renderTemplate(getTemplate('event-image', 'embed'), {
                          IMAGE_URL: `/imageProxy/external/${Buffer.from(coverUrl).toString(
                              'base64'
                          )}`,
                      })
                    : '';

            const eventEmbed = renderTemplate(getTemplate('event', 'embed'), {
                GUILD_ICON: guildIconHtml,
                GUILD_NAME: escape(guild.name),
                EVENT_NAME: escape(event.name),
                EVENT_TIME: formatDateWithTimezone(event.scheduledStartAt, clientTimezone),
                EVENT_LOCATION: locationHtml,
                EVENT_DESCRIPTION: descriptionHtml,
                EVENT_INTERESTED: interestedHtml,
                EVENT_IMAGE: imageHtml,
            });

            result = replaceOrAppendMedia(result, match[0], eventEmbed);
        } catch (err) {
            console.error('Error rendering Discord event embed:', err);
        }
    }

    return result;
}

async function renderDiscordInvites(messagetext, item, bot, imagesCookie) {
    let result = messagetext || '';
    if (!item?.content) return result;

    const inviteRegex = /discord(?:app)?\.(?:gg|com\/invite)\/([a-zA-Z0-9-]+)/gi;
    const matches = [...item.content.matchAll(inviteRegex)];

    if (matches.length === 0) return result;

    const processedInvites = new Set();

    for (const match of matches) {
        const inviteCode = match[1];
        if (processedInvites.has(inviteCode)) continue;
        processedInvites.add(inviteCode);

        try {
            const invite = await bot.client.fetchInvite(inviteCode).catch(() => null);
            if (!invite || !invite.guild) continue;

            const iconUrl = invite.guild.iconURL({ size: 128 });
            const iconHtml =
                iconUrl && imagesCookie === 1
                    ? renderTemplate(getTemplate('invite-icon', 'embed'), {
                          ICON_URL: `/imageProxy/external/${Buffer.from(iconUrl).toString('base64')}`,
                      })
                    : renderTemplate(getTemplate('invite-icon-none', 'embed'), {});

            const inviteEmbed = renderTemplate(getTemplate('invite', 'embed'), {
                GUILD_NAME: escape(invite.guild.name),
                ONLINE_COUNT: (invite.presenceCount || 0).toLocaleString(),
                MEMBER_COUNT: (invite.memberCount || 0).toLocaleString(),
                INVITE_ICON: iconHtml,
                INVITE_URL: `https://discord.gg/${inviteCode}`,
            });

            result = replaceOrAppendMedia(result, match[0], inviteEmbed);
        } catch (err) {
            console.error('Error rendering Discord invite embed:', err);
        }
    }

    return result;
}

/**
 * Renders an activity banner for messages that are activity shares or replies (type 25).
 *
 * @param {object} item - The Discord message object.
 * @param {object} context - Rendering context.
 * @returns {string} The rendered activity banner HTML or an empty string.
 */
function renderActivityBanner(item, context) {
    const { templates, req } = context;
    // Activity Reply is type 25. Shared activities may also have .activity
    if (item.type !== 25 && !item.activity) return '';

    const embed = item.embeds?.[0] || item.messageSnapshots?.first()?.embeds?.[0];

    // If we don't have enough info to show a banner, skip it
    if (!embed && !item.activity && !item.applicationId) return '';

    const authorName = getDisplayName(item.member, item.author);
    const gameName = embed?.title || item.activity?.name || 'a game';

    // Duration: Check embed description or footer for time info
    let duration = 'Played recently';
    if (
        embed?.footer?.text &&
        (embed.footer.text.includes('ago') || embed.footer.text.includes(':'))
    ) {
        duration = embed.footer.text;
    } else if (embed?.description && embed.description.includes('ago')) {
        const agoMatch = embed.description.match(/\d+\s+\w+\s+ago/);
        if (agoMatch) duration = agoMatch[0];
    }

    // Icon: Use embed thumbnail, or try application icon
    let iconUrl = embed?.thumbnail?.url || '/resources/twemoji/1f3ae.gif';
    if (!embed?.thumbnail?.url && item.applicationId) {
        iconUrl = `https://cdn.discordapp.com/app-icons/${item.applicationId}/icon.png`;
    }

    // Theme-aware colors
    const cookies = parseCookies(req);
    const themeValue = parseInt(cookies.whiteThemeCookie, 10) || 0;
    const isLight = themeValue === 1;

    return renderTemplate(templates.activityBanner, {
        AUTHOR_NAME: escape(authorName),
        ACTIVITY_TEXT: escape(`Played ${gameName}`),
        ACTIVITY_ICON: escape(iconUrl),
        DURATION_AGO: escape(duration),
        AUTHOR_COLOR: isLight ? '#060607' : '#ffffff',
        TEXT_COLOR: isLight ? '#060607' : '#dcddde',
        MUTE_COLOR: isLight ? '#5c5e66' : '#b5bac1',
        BORDER_COLOR: isLight ? '#e3e5e8' : '#40444b',
        BG_COLOR: isLight ? 'rgba(79, 84, 92, 0.08)' : 'rgba(79, 84, 92, 0.16)',
    });
}


/**
 * Renders a poll result summary from a Discord poll embed.
 *
 * @param {object} embed - The poll result embed object.
 * @returns {string} The rendered poll result HTML.
 */
function renderPollResultEmbed(embed) {
    const fieldMap = {};
    (embed.fields ?? []).forEach((f) => {
        fieldMap[f.name] = f.value;
    });
    const question = fieldMap['poll_question_text'] ?? '';
    const winnerText = fieldMap['victor_answer_text'] ?? '';
    const winnerEmoji = fieldMap['victor_answer_emoji_name'] ?? '';
    const winnerVotes = fieldMap['victor_answer_votes'] ?? '0';
    const totalVotes = fieldMap['total_votes'] ?? '0';
    const emojiPart = winnerEmoji ? escape(winnerEmoji) + ' ' : '';

    return renderTemplate(getTemplate('poll-result', 'channel'), {
        QUESTION: escape(question),
        WINNER_EMOJI: emojiPart,
        WINNER_TEXT: escape(winnerText),
        WINNER_VOTES: escape(winnerVotes),
        TOTAL_VOTES: escape(totalVotes),
    });
}

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

/**
 * Renders a role mention pill with appropriate coloring.
 *
 * @param {object} role - The Discord role object.
 * @param {string} tmpl_mention - The base mention template.
 * @returns {string} The HTML for the role mention pill.
 */

function roleMentionPill(role, tmpl_mention) {
    const name = escape('@' + normalizeWeirdUnicode(role.name));
    if (role.color !== 0) {
        const hex = role.hexColor;
        const r = parseInt(hex.slice(1, 3), 16),
            g = parseInt(hex.slice(3, 5), 16),
            b = parseInt(hex.slice(5, 7), 16);
        return renderTemplate(getTemplate('role-mention-colored', 'channel'), {
            HEX: hex,
            R: r.toString(),
            G: g.toString(),
            B: b.toString(),
            NAME: name,
        });
    }
    return renderTemplate(getTemplate('role-mention-plain', 'channel'), { NAME: name });
}

/**
 * Renders mentions that are already known/available in the message object.
 *
 * @param {string} messagetext - The text to process.
 * @param {object} item - The Discord message object.
 * @param {string} discordID - The current user's Discord ID.
 * @param {object} member - The current user's member object.
 * @param {object} templates - Object containing HTML templates.
 * @returns {string} The text with known mentions rendered.
 */

function renderKnownMentions(messagetext, item, discordID, member, templates) {
    let result = messagetext;
    if (!item.mentions) return result;

    const members = item.mentions.members?.values
        ? Array.from(item.mentions.members.values())
        : item.mentions.members || [];
    if (Array.isArray(members)) {
        for (const user of members) {
            if (!user) continue;
            const tmpl = user.id === discordID ? templates.mentionHighlighted : templates.mention;
            const pill = renderTemplate(tmpl, {
                '{$USERNAME}': escape('@' + normalizeWeirdUnicode(user.displayName)),
            });
            result = result.split(`&lt;@${user.id}&gt;`).join(pill);
            result = result.split(`&lt;@!${user.id}&gt;`).join(pill);
        }
    }

    if (item.mentions.roles) {
        const roles = item.mentions.roles.values
            ? Array.from(item.mentions.roles.values())
            : item.mentions.roles;
        if (Array.isArray(roles)) {
            for (const role of roles) {
                if (!role) continue;
                const tmpl =
                    member && member.roles.cache?.has(role.id)
                        ? templates.mentionHighlighted
                        : templates.mention;
                result = result.split(`&lt;@&amp;${role.id}&gt;`).join(roleMentionPill(role, tmpl));
            }
        }
    }

    return result;
}

/**
 * Resolves and renders any remaining user mentions that weren't in the initial message object.
 *
 * @param {string} messagetext - The text to process.
 * @param {object} chnl - The Discord channel object.
 * @param {Map} memberCache - Cache of fetched members.
 * @param {string} tmpl_mention - The template for mentions.
 * @returns {Promise<string>} The text with resolved mentions.
 */

async function resolveRemainingMentions(messagetext, chnl, memberCache, tmpl_mention) {
    const unresolvedIds = [...messagetext.matchAll(/&lt;@!?(\d{16,20})&gt;/g)]
        .map((m) => m[1])
        .filter((id) => !memberCache.has(id));
    await Promise.allSettled(
        unresolvedIds.map(async (id) => {
            try {
                memberCache.set(id, await chnl.guild.members.fetch(id));
            } catch {
                memberCache.set(id, null);
            }
        })
    );
    return messagetext.replace(/&lt;@!?(\d{16,20})&gt;/g, (match, userId) => {
        const resolved = memberCache.get(userId) ?? chnl.guild.members.cache.get(userId);
        return resolved
            ? renderTemplate(tmpl_mention, {
                  '{$USERNAME}': escape(
                      '@' + normalizeWeirdUnicode(getDisplayName(resolved, resolved.user))
                  ),
              })
            : renderTemplate(tmpl_mention, { '{$USERNAME}': '@unknown-user' });
    });
}

/**
 * Resolves and renders channel mentions.
 *
 * @param {string} messagetext - The text to process.
 * @param {object} bot - The bot instance.
 * @param {object} chnl - The current Discord channel object.
 * @returns {Promise<string>} The text with channel mentions resolved.
 */

async function resolveChannelMentions(messagetext, bot, chnl) {
    const unresolvedIds = [...messagetext.matchAll(/&lt;#(\d{16,20})&gt;/g)]
        .map((m) => m[1])
        .filter((id) => !bot.client.channels.cache.has(id));
    await Promise.allSettled(
        unresolvedIds.map(async (id) => {
            try {
                await bot.client.channels.fetch(id);
            } catch {}
        })
    );
    return messagetext.replace(/&lt;#(\d{16,20})&gt;/g, (match, id) => {
        const { ChannelType } = require('discord.js');
        const ch = bot.client.channels.cache.get(id);
        if (!ch) return match;
        if (ch.type === ChannelType.GuildForum || ch.type === ChannelType.GuildMedia)
            return '#' + escape(normalizeWeirdUnicode(ch.name));
        return renderTemplate(getTemplate('channel-mention', 'channel'), {
            CHANNEL_URL: `/channels/${ch.id}`,
            CHANNEL_NAME: escape(normalizeWeirdUnicode(ch.name)),
        });
    });
}

/**
 * Renders @everyone and @here mentions.
 *
 * @param {string} messagetext - The text to process.
 * @param {object} item - The Discord message object.
 * @param {object} templates - Object containing HTML templates.
 * @returns {string} The text with global mentions rendered.
 */

function renderEveryoneMentions(messagetext, item, templates) {
    if (!item.mentions?.everyone) return messagetext;
    const tmpl = templates.mention;
    let result = messagetext;
    if (result.includes('@everyone'))
        result = result
            .split('@everyone')
            .join(renderTemplate(tmpl, { '{$USERNAME}': '@everyone' }));
    if (result.includes('@here'))
        result = result.split('@here').join(renderTemplate(tmpl, { '{$USERNAME}': '@here' }));
    return result;
}

function detectMention(item, member, discordID, isReply, replyData) {
    if (
        item.mentions?.members?.has?.(discordID) ||
        (Array.isArray(item.mentions?.members) &&
            item.mentions.members.some((m) => m.id === discordID))
    ) {
        if (isReply && item.author?.id === discordID && replyData?.authorId === discordID) {
            const mentionRegex = new RegExp(`<@!?${discordID}>`);
            if (!mentionRegex.test(item.content)) return false;
        }
        return true;
    }
    if (isReply && replyData.mentionsPing && replyData.authorId === discordID) return true;
    if (item.mentions?.everyone) return true;
    if (item.mentions?.roles && member) {
        const roles = item.mentions.roles.values
            ? Array.from(item.mentions.roles.values())
            : item.mentions.roles;
        if (Array.isArray(roles)) {
            for (const role of roles) {
                if (role && member.roles.cache?.has(role.id)) return true;
            }
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Group Metadata Resolution
// ---------------------------------------------------------------------------

/**
 * Resolves and processes data for forwarded messages.
 *
 * @param {object} item - The Discord message object.
 * @param {object} chnl - The Discord channel object.
 * @param {object} bot - The bot instance.
 * @param {string} discordID - The current user's Discord ID.
 * @param {Map} memberCache - Cache of fetched members.
 * @param {string} clientTimezone - The user's timezone.
 * @param {object} req - The HTTP request object.
 * @param {number} imagesCookie - User preference for images.
 * @param {number} animationsCookie - User preference for animations.
 * @param {string} barColor - CSS color for the side bar.
 * @returns {Promise<object|null>} Resolved forward data or null.
 */

async function resolveForwardData(
    item,
    chnl,
    bot,
    discordID,
    memberCache,
    clientTimezone,
    req,
    imagesCookie,
    animationsCookie,
    barColor
) {
    try {
        const fwdMsg = await item.fetchReference();

        const fwdMember = fwdMsg.author?.bot
            ? null
            : await ensureMemberData(fwdMsg, chnl.guild, memberCache);

        const originHtml = await (async () => {
            if (!fwdMsg.guildId || !fwdMsg.channelId || !fwdMsg.id) return '';

            const fwdChannel = fwdMsg.channel ?? bot.client.channels.cache.get(fwdMsg.channelId);

            if (!fwdChannel) return '';

            const chanLink = renderTemplate(getTemplate('forwarded-origin-channel', 'misc'), {
                JUMP_LINK: `/channels/${fwdMsg.channelId}/${fwdMsg.id}`,
                CHANNEL_NAME: escape(normalizeWeirdUnicode(fwdChannel.name)),
                TIME: formatForwardedTimestamp(fwdMsg.createdAt, clientTimezone),
            });

            if (fwdMsg.guildId === chnl.guild.id)
                return renderTemplate(getTemplate('forwarded-same-server', 'channel'), {
                    CONTENT: chanLink,
                });

            const otherGuild = bot.client.guilds.cache.get(fwdMsg.guildId);

            if (!otherGuild) return '';

            await otherGuild.members.fetch(discordID);

            return renderTemplate(getTemplate('forwarded-other-server', 'channel'), {
                GUILD_NAME: escape(normalizeWeirdUnicode(otherGuild.name)),
                CONTENT: chanLink,
            });
        })().catch(() => '');

        const snapshotMsg = item.messageSnapshots?.first();

        const embedsHtml = renderEmbeds(
            '',
            fwdMsg.embeds?.length ? fwdMsg : (snapshotMsg ?? fwdMsg),
            req,
            imagesCookie,
            animationsCookie,
            clientTimezone
        );

        const resolvedContent = await resolveRawMentionsForPreview(
            fwdMsg.content || '',
            fwdMsg,
            memberCache,
            chnl,
            bot
        );

        return {
            author: getDisplayName(fwdMember, fwdMsg.author),
            content: renderDiscordMarkdown(
                truncateText(resolvedContent, FORWARDED_CONTENT_MAX_LENGTH),
                { barColor }
            ),
            date: formatDateWithTimezone(fwdMsg.createdAt, clientTimezone),
            origin: originHtml,
            embeds: embedsHtml,
        };
    } catch {
        const snapshotMsg = item.messageSnapshots?.first();

        if (!snapshotMsg) return null;

        const resolvedContent = await resolveRawMentionsForPreview(
            snapshotMsg.content || '',
            snapshotMsg,
            memberCache,
            chnl,
            bot
        );

        return {
            author: getDisplayName(null, snapshotMsg.author) || '',
            content: renderDiscordMarkdown(
                truncateText(resolvedContent, FORWARDED_CONTENT_MAX_LENGTH),
                { barColor }
            ),
            date: snapshotMsg.createdAt
                ? formatDateWithTimezone(snapshotMsg.createdAt, clientTimezone)
                : '',
            origin: '',
            embeds: renderEmbeds(
                '',
                snapshotMsg,
                req,
                imagesCookie,
                animationsCookie,
                clientTimezone
            ),
        };
    }
}

async function resolveRawMentionsForPreview(text, msg, memberCache, chnl, bot) {
    const members = msg.mentions?.members?.values
        ? Array.from(msg.mentions.members.values())
        : msg.mentions?.members || [];

    if (Array.isArray(members)) {
        for (const m of members) {
            if (!m) continue;
            const name = '@' + normalizeWeirdUnicode(getDisplayName(m, m.user));
            text = text.split(`<@${m.id}>`).join(name);
            text = text.split(`<@!${m.id}>`).join(name);
        }
    }

    const roles = msg.mentions?.roles?.values
        ? Array.from(msg.mentions.roles.values())
        : msg.mentions?.roles || [];

    if (Array.isArray(roles)) {
        for (const r of roles) {
            if (!r) continue;
            text = text.split(`<@&${r.id}>`).join('@' + normalizeWeirdUnicode(r.name));
        }
    }

    const unresolvedUserIds = [...text.matchAll(/<@!?(\d{16,20})>/g)]
        .map((m) => m[1])
        .filter((id) => !memberCache.has(id));

    await Promise.allSettled(
        unresolvedUserIds.map(async (id) => {
            try {
                memberCache.set(id, await chnl.guild.members.fetch(id));
            } catch {
                memberCache.set(id, null);
            }
        })
    );

    text = text.replace(/<@!?(\d{16,20})>/g, (match, id) => {
        const cached = memberCache.get(id) ?? chnl.guild.members.cache.get(id);
        return cached ? '@' + normalizeWeirdUnicode(getDisplayName(cached, cached.user)) : match;
    });

    const unresolvedChannelIds = [...text.matchAll(/<#(\d{16,20})>/g)]
        .map((m) => m[1])
        .filter((id) => !bot.client.channels.cache.has(id));

    await Promise.allSettled(
        unresolvedChannelIds.map(async (id) => {
            try {
                await bot.client.channels.fetch(id);
            } catch {}
        })
    );

    text = text.replace(/<#(\d{16,20})>/g, (match, id) => {
        const ch = bot.client.channels.cache.get(id);
        return ch ? '#' + normalizeWeirdUnicode(ch.name) : match;
    });

    return text;
}

/**
 * Resolves and processes data for message replies.
 *
 * @param {object} item - The Discord message object.
 * @param {object} chnl - The Discord channel object.
 * @param {Map} memberCache - Cache of fetched members.
 * @param {object} bot - The bot instance.
 * @param {number} imagesCookie - User preference for images.
 * @param {number} animationsCookie - User preference for animations.
 * @param {string} barColor - CSS color for the side bar.
 * @param {string} authorText - CSS color for author names.
 * @returns {Promise<object|null>} Resolved reply data or null.
 */

async function resolveReplyData(
    item,
    chnl,
    memberCache,
    bot,
    imagesCookie,
    animationsCookie,
    barColor,
    authorText
) {
    try {
        const replyMessage = await item.fetchReference().catch(() => null);

        const replyUser = replyMessage?.author ?? item.mentions?.repliedUser;

        const replyMember = await (async () => {
            if (replyMessage)
                return replyMessage.author?.bot
                    ? null
                    : await ensureMemberData(replyMessage, chnl.guild, memberCache);

            if (!replyUser?.id) return undefined;

            if (memberCache.has(replyUser.id)) return memberCache.get(replyUser.id);

            return chnl.guild.members
                .fetch(replyUser.id)
                .then((m) => {
                    memberCache.set(replyUser.id, m);
                    return m;
                })
                .catch(() => undefined);
        })();

        const replyContent = replyMessage?.content
            ? await (async () => {
                  const resolvedFlat = await resolveRawMentionsForPreview(
                      replyMessage.content.replace(/\r?\n/g, ' ').replace(/  +/g, ' ').trim(),
                      replyMessage,
                      memberCache,
                      chnl,
                      bot
                  );

                  return truncateText(
                      resolvedFlat.replace(/^(>>?>?\s*)+/, ''),
                      REPLY_CONTENT_MAX_LENGTH
                  );
              })()
            : '';

        return {
            author: getDisplayName(replyMember, replyUser),
            authorId: replyUser?.id,
            authorColor: getMemberColor(replyMember, authorText),
            mentionsPing:
                item.mentions?.repliedUser !== null &&
                item.mentions?.repliedUser !== undefined &&
                item.author?.id !== replyUser?.id,
            content: replyContent,
        };
    } catch (err) {
        console.error('Could not process reply data:', err);
        return null;
    }
}

function buildReplyIndicator(replyData, replyText, barColor = '#808080') {
    const normalizedReplyContent = (replyData.content || '')
        .replace(/<br[^>]*>/gi, ' ')
        .replace(/\r?\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const contentTd = normalizedReplyContent
        ? renderTemplate(getTemplate('reply-content-cell', 'channel'), {
              REPLY_TEXT_TOP_OFFSET: '-1',
              REPLY_TEXT: replyText,
              REPLY_PREVIEW: he.encode(normalizedReplyContent, { useNamedReferences: true }),
          })
        : '';

    const replyContent = renderTemplate(getTemplate('reply-with-content', 'channel'), {
        BAR_COLOR: barColor,
        REPLY_TEXT_TOP_OFFSET: '-1',
        AUTHOR_COLOR: replyData.authorColor,
        AT_SIGN: replyData.mentionsPing ? '@' : '',
        AUTHOR_NAME: escape(replyData.author),
        CONTENT_TD: contentTd,
    });

    return renderTemplate(getTemplate('reply-container', 'channel'), {
        CONTENT: replyContent,
    });
}

/**
 * Resolves and processes data for message interactions (slash commands).
 *
 * @param {object} item - The Discord message object.
 * @param {object} chnl - The Discord channel object.
 * @param {Map} memberCache - Cache of fetched members.
 * @param {string} authorText - CSS color for author names.
 * @returns {Promise<object|null>} Resolved interaction data or null.
 */

async function resolveInteractionData(item, chnl, memberCache, authorText) {
    try {
        const user = item.interaction?.user;
        if (!user) return null;
        const cached = memberCache.get(user.id);
        const member =
            cached !== undefined
                ? cached
                : await chnl.guild.members
                      .fetch(user.id)
                      .then((m) => {
                          memberCache.set(user.id, m);
                          return m;
                      })
                      .catch(() => undefined);
        return {
            author: getDisplayName(member, user),
            authorColor: getMemberColor(member, authorText),
            commandName: item.interaction.commandName,
        };
    } catch (err) {
        console.error('Could not process interaction data:', err);
        return null;
    }
}

function buildInteractionIndicator(interactionData, textColor, barColor = '#808080') {
    const content = renderTemplate(getTemplate('interaction-indicator', 'channel'), {
        BAR_COLOR: barColor,
        AUTHOR_COLOR: interactionData.authorColor,
        AUTHOR_NAME: escape(interactionData.author),
        TEXT_COLOR: textColor,
        COMMAND_NAME: escape(interactionData.commandName),
    });

    return renderTemplate(getTemplate('interaction-container', 'channel'), {
        CONTENT: content,
    });
}

// ---------------------------------------------------------------------------
// Flushing and Grouping
// ---------------------------------------------------------------------------

/**
 * Builds the HTML for author badges (Bot, Webhook, Discross).
 *
 * @param {object} state - The current message grouping state.
 * @returns {string} The HTML for author pills.
 */

function buildAuthorPills(state) {
    let pills = '';
    const isVerifiedBot = state.lastIsVerified;
    const isSlashCommand = state.lastIsInteraction;
    const isWebhook = state.lastIsWebhook;
    const isDiscross = state.lastIsDiscross;

    if (isDiscross) {
        const client = parseUserAgent(state.lastUserAgent);
        const icon = client ? `/resources/images/clients/${client.id}.png` : '/resources/logo.gif';
        const alt = client ? `Sent using ${client.name}` : 'Sent with an unknown client';

        pills += renderTemplate(getTemplate('discross-pill', 'channel'), {
            CLIENT_ICON: icon,
            CLIENT_ALT: alt,
        });
    } else {
        if (isVerifiedBot || isSlashCommand) {
            pills += getTemplate('verified-app-pill', 'channel');
        } else if (isWebhook) {
            pills += getTemplate('app-pill', 'channel');
        }
    }
    return pills;
}

/**
 * Flushes the current message group state into a final HTML block.
 *
 * This function takes all accumulated messages in `state.currentmessage` and wraps them
 * in the appropriate outer message template (e.g. normal, mentioned, forwarded).
 * It also prepends the author's name, color, and any reply/interaction indicators.
 *
 * @param {object} state - The current message grouping state.
 * @param {object} templates - Object containing HTML templates.
 * @param {string} authorText - CSS color for author names.
 * @param {string} replyText - CSS color for reply text.
 * @param {string} barColor - CSS color for the side bar.
 * @param {string} channelId - The current channel ID.
 * @returns {string} The completed HTML for the message group.
 */

function flushMessageGroup(state, templates, authorText, replyText, barColor, channelId) {
    // Jump link for the message group (uses the ID of the first message).
    const replyLink = channelId
        ? `/channels/${channelId}/${state.messageid}`
        : 'javascript:void(0)';

    // 1. Determine the outer template based on message type and mentions.
    const baseHtml = (() => {
        // A continuation block is a group that starts mid-way through a multi-message block
        // (e.g. if the first message in the fetch was actually a merged message).
        if (state.isContinuationBlock && !state.isForwarded && !state.lastMentioned)
            return renderTemplate(templates.messageContinuation, {
                '{$MESSAGE_CONTENT}': state.currentmessage,
            });

        // Mentioned messages get a yellow-ish background/highlight.
        if (state.isForwarded && state.lastMentioned)
            return renderTemplate(templates.messageForwardedMentioned, {
                '{$MESSAGE_CONTENT}': state.currentmessage,
                '{$MESSAGE_REPLY_LINK}': replyLink,
            });

        if (state.isForwarded)
            return renderTemplate(templates.messageForwarded, {
                '{$MESSAGE_CONTENT}': state.currentmessage,
                '{$MESSAGE_REPLY_LINK}': replyLink,
            });

        if (state.lastMentioned)
            return renderTemplate(templates.messageMentioned, {
                '{$MESSAGE_CONTENT}': state.currentmessage,
                '{$MESSAGE_REPLY_LINK}': replyLink,
            });

        // Default normal message template.
        return renderTemplate(templates.message, {
            '{$MESSAGE_CONTENT}': state.currentmessage,
            '{$MESSAGE_REPLY_LINK}': replyLink,
        });
    })();

    // 2. Handle Forwarded Content Blocks.
    const contentBlock =
        state.isForwarded && state.forwardData.content
            ? renderTemplate(getTemplate('forwarded-content-block', 'channel'), {
                  CONTENT: state.forwardData.content,
              })
            : '';

    // Apply forwarded metadata to the template.
    const afterForwarded = state.isForwarded
        ? renderTemplate(baseHtml, {
              '{$FORWARDED_AUTHOR}': escape(state.forwardData.author),
              '{$FORWARDED_CONTENT_BLOCK}': contentBlock,
              '{$FORWARDED_DATE}': state.forwardData.date,
              '{$FORWARDED_EMBEDS}': state.forwardData.embeds ?? '',
              '{$FORWARDED_ORIGIN}': state.forwardData.origin ?? '',
          })
        : baseHtml;

    // 3. Apply Author and Indicators.
    const authorColor = getMemberColor(state.lastmember, authorText);

    // If the group starts with a reply or was an interaction, build the top "indicator" bar.
    const replyIndicator = state.lastReply
        ? buildReplyIndicator(state.lastReplyData, replyText, barColor)
        : state.lastInteraction
          ? buildInteractionIndicator(state.lastInteractionData, replyText, barColor)
          : '';

    return renderTemplate(afterForwarded, {
        '{$MESSAGE_AUTHOR}':
            escape(getDisplayName(state.lastmember, state.lastauthor)) + buildAuthorPills(state),
        '{$AUTHOR_COLOR}': authorColor,
        '{$REPLY_INDICATOR}': replyIndicator,
        '{$PING_INDICATOR}': '', // Placeholder for future ping visual effects
        '{$MESSAGE_DATE}': formatDateWithTimezone(state.lastdate, state.clientTimezone),
        // The tag is used by the frontend for mention/reply logic.
        '{$TAG}': he.encode(JSON.stringify(`<@${state.lastauthor.id}>`)),
    });
}

/**
 * Renders the full content of a single message, including markdown, mentions, emojis, and attachments.
 *
 * @param {object} item - The Discord message object.
 * @param {object} context - Rendering context and configuration.
 * @returns {Promise<string>} The rendered message content as HTML.
 */

async function renderMessageContent(item, context) {
    const {
        bot,
        chnl,
        member,
        discordID,
        req,
        imagesCookie,
        animationsCookie,
        clientTimezone,
        memberCache,
        templates,
        barColor,
    } = context;

    const withMarkdown = renderDiscordMarkdown(item.content || '', {
        barColor,
        timezone: clientTimezone,
    });

    const withDiscordTimestamps = replaceDiscordTimestamps(withMarkdown, clientTimezone);

    const withEmojis = renderEmojis(withDiscordTimestamps, item, imagesCookie, animationsCookie);

    const withAttachments = renderAttachments(
        withEmojis,
        item,
        imagesCookie,
        templates.fileDownload
    );

    const withStickers = renderStickers(withAttachments, item, imagesCookie);

    const withEmbeds = renderEmbeds(
        withStickers,
        item,
        req,
        imagesCookie,
        animationsCookie,
        clientTimezone
    );

    const withEvents = await renderDiscordEvents(
        withEmbeds,
        item,
        bot,
        imagesCookie,
        clientTimezone
    );

    const withInvites = await renderDiscordInvites(withEvents, item, bot, imagesCookie);

    const withPoll = item?.poll ? withInvites + processPoll(item.poll, imagesCookie) : withInvites;

    const activityBanner = renderActivityBanner(item, context);
    const withActivity = withPoll + activityBanner;

    const withKnownMentions = renderKnownMentions(withActivity, item, discordID, member, templates);

    const withRemainingMentions = await resolveRemainingMentions(
        withKnownMentions,
        chnl,
        memberCache,
        templates.mention
    );

    const withChannelMentions = await resolveChannelMentions(withRemainingMentions, bot, chnl);

    const withEveryoneMentions = renderEveryoneMentions(withChannelMentions, item, templates);

    let withRoleMentions = withEveryoneMentions;

    if (item.mentions?.roles) {
        const roles = item.mentions.roles.values
            ? Array.from(item.mentions.roles.values())
            : item.mentions.roles;

        if (Array.isArray(roles)) {
            for (const role of roles) {
                if (!role) continue;
                const hasRole = member && member.roles.cache?.has(role.id);
                const tmpl = hasRole ? templates.mentionHighlighted : templates.mention;
                withRoleMentions = withRoleMentions
                    .split(`&lt;@&amp;${role.id}&gt;`)
                    .join(roleMentionPill(role, tmpl));
            }
        }
    }

    return withRoleMentions;
}

// ---------------------------------------------------------------------------
// Main Public APIs
// ---------------------------------------------------------------------------

/**
 * Orchestrates the rendering of a list of Discord messages into an HTML string.
 *
 * This is the core logic for the channel view. It performs several key tasks:
 * 1. Message Grouping: Merges consecutive messages from the same author into a single visual block.
 * 2. State Management: Tracks metadata (author, date, mentions, replies) across the message list.
 * 3. Component Injection: Renders markdown, emojis, attachments, embeds, and reactions.
 * 4. System Messages: Handles non-normal messages (joins, boosts, pins, etc.).
 *
 * The logic uses a "look-back" approach where each iteration processes an 'item' but may flush
 * the PREVIOUS message group if a new author or a timeout (7 minutes) is detected.
 *
 * @param {object} params - Configuration parameters for rendering.
 * @param {object} params.bot - The bot instance.
 * @param {object} params.chnl - The Discord channel object.
 * @param {object} params.member - The current user's member object.
 * @param {string} params.discordID - The current user's Discord ID.
 * @param {object} params.req - The HTTP request object.
 * @param {number} params.imagesCookie - User preference for images.
 * @param {number} [params.animationsCookie=1] - User preference for animations.
 * @param {string} params.authorText - CSS color for author names.
 * @param {string} params.replyText - CSS color for reply text.
 * @param {string} [params.barColor='#808080'] - CSS color for side bars.
 * @param {string} params.clientTimezone - The user's timezone.
 * @param {string} params.channelId - The current channel ID.
 * @param {Array} [params.messages] - Optional override for message history.
 * @param {object} [params.templates] - Optional override for HTML templates.
 * @returns {Promise<string>} The complete HTML for the channel's messages.
 */

exports.buildMessagesHtml = async function buildMessagesHtml(params) {
    const {
        bot,
        chnl,
        member,
        discordID,
        req,
        imagesCookie,
        animationsCookie = 1,
        authorText,
        replyText,
        barColor = '#808080',
        clientTimezone,
        channelId,
        messages: overrideMessages,
        templates: overrideTemplates,
    } = params;

    // 1. Initialize templates. We use subfolders for organized template retrieval.
    const templates = overrideTemplates ?? {
        message: getTemplate('message', 'message'),
        messageForwarded: getTemplate('forwarded-message', 'message'),
        messageMentioned: getTemplate('message-mentioned', 'message'),
        messageForwardedMentioned: getTemplate('forwarded-message-mentioned', 'message'),
        firstMessageContent: getTemplate('first-message-content', 'message'),
        mergedMessageContent: getTemplate('merged-message-content', 'message'),
        mention: getTemplate('mention', 'message'),
        mentionHighlighted: getTemplate('mention', 'message'),
        fileDownload: getTemplate('file-download', 'channel'),
        reactions: getTemplate('reactions', 'message'),
        reaction: getTemplate('reaction', 'message'),
        dateSeparator: getTemplate('date-separator', 'message'),
        messageContinuation: getTemplate('message-continuation', 'message'),
        activityBanner: getTemplate('activity-banner', 'channel'),
    };

    // 2. Fetch messages (or use override).
    const messages = overrideMessages ?? (await bot.getHistoryCached(chnl));

    // memberCache is used to avoid redundant Discord API calls for avatars/names within this render pass.
    const memberCache = new Map();

    const context = {
        bot,
        chnl,
        member,
        discordID,
        req,
        imagesCookie,
        animationsCookie,
        clientTimezone,
        memberCache,
        templates,
        barColor,
    };

    let response = '';

    // 3. The State Machine.
    // Tracks the current message block's metadata.
    const state = {
        lastauthor: undefined, // Author of the previous message
        lastmember: undefined, // GuildMember object of the previous author
        lastdate: new Date('1995-12-17T03:24:00'), // Timestamp of the last message in the group
        lastmessagedate: null, // Used for date separator logic
        currentmessage: '', // Accumulated HTML for the current message group
        messageid: 0, // ID of the first message in the group (for jump links)
        isForwarded: false, // Whether the group contains a forwarded message
        forwardData: {}, // Metadata for forwarded content
        lastMentioned: false, // Whether the current user was mentioned in the group
        lastReply: false, // Whether the group starts with a reply
        lastReplyData: {}, // Metadata for the reply reference
        lastForwarded: false, // Previous message was forwarded
        lastInteraction: false, // Whether the group was triggered by a slash command
        lastInteractionData: {}, // Metadata for the interaction
        isContinuationBlock: false, // Whether this group is a merge of previous messages
        lastIsBot: false, // Author is a bot
        lastIsVerified: false, // Author is a verified bot
        lastIsWebhook: false, // Message was sent via webhook
        lastIsInteraction: false, // Message has interaction metadata
        lastIsDiscross: false, // Message was specifically sent via Discross
        clientTimezone,
    };

    // We append 'null' to the end of the loop to trigger the final flushMessageGroup call.
    for (const item of [...messages, null]) {
        // Pre-calculate Discross/UA for the current item to decide on grouping
        let currentIsDiscross = false;
        let currentUserAgent = null;

        if (item) {
            const isBotSelf = item.author.id === bot.client.user.id;
            const isDiscrossWebhook =
                item.webhookId &&
                auth.dbQuerySingle('SELECT webhookID FROM webhooks WHERE webhookID=?', [
                    item.webhookId,
                ]);
            currentIsDiscross = !!(isBotSelf || isDiscrossWebhook);
            if (currentIsDiscross) {
                const uaRow = auth.dbQuerySingle(
                    'SELECT userAgent FROM message_user_agents WHERE messageID=?',
                    [item.id]
                );
                currentUserAgent = uaRow ? uaRow.userAgent : null;
            }
        }

        /**
         * Helper to determine if a message should start a new visual group.
         * Groups are split if:
         * - The author changes.
         * - More than 7 minutes have passed.
         * - It's a reply, forwarded message, or interaction.
         * - The Discross client (User-Agent) changed.
         */
        const shouldStartNewGroup = (item) =>
            !state.lastauthor ||
            !isSameAuthor(state.lastmember, state.lastauthor, null, item.author) ||
            item.createdAt - state.lastdate > MESSAGE_GROUP_TIMEOUT_MS ||
            !!item.reference ||
            state.lastReply ||
            state.lastInteraction ||
            state.lastForwarded ||
            (currentIsDiscross && currentUserAgent !== state.lastUserAgent) ||
            (!currentIsDiscross && state.lastIsDiscross);

        // --- Flush Logic ---
        if (state.lastauthor) {
            if (!item || shouldStartNewGroup(item)) {
                // The author changed or we reached the end; wrap the previous messages in an author block.
                response += flushMessageGroup(
                    state,
                    templates,
                    authorText,
                    replyText,
                    barColor,
                    channelId
                );
                state.currentmessage = '';
            }
        }

        if (!item) break;

        // --- Per-Message Processing ---

        // Ensure we have the latest member data for roles and display names.
        const currentMember = await ensureMemberData(item, chnl.guild, memberCache);

        // Date Separators: Insert a visual "March 15, 2024" bar when the day changes.
        if (areDifferentDays(item.createdAt, state.lastmessagedate, clientTimezone))
            response += renderTemplate(templates.dateSeparator, {
                '{$DATE_SEPARATOR}': formatDateSeparator(item.createdAt, clientTimezone),
            });

        state.lastmessagedate = item.createdAt;

        // Forwarded Messages: Extract content from reference or snapshots.
        const fwdData =
            item.reference?.type === MessageReferenceType.Forward
                ? await resolveForwardData(
                      item,
                      chnl,
                      bot,
                      discordID,
                      memberCache,
                      clientTimezone,
                      req,
                      imagesCookie,
                      animationsCookie,
                      barColor
                  )
                : null;

        const isForwarded = fwdData !== null,
            forwardData = fwdData ?? {};

        // Replies: Extract the referenced message and its author.
        const rplyData =
            item.reference && !isForwarded
                ? await resolveReplyData(
                      item,
                      chnl,
                      memberCache,
                      bot,
                      imagesCookie,
                      animationsCookie,
                      barColor,
                      authorText
                  )
                : null;

        const isReply = rplyData !== null,
            replyData = rplyData ?? {};

        // Interactions: Extract slash command metadata.
        const intData = item.interaction
            ? await resolveInteractionData(item, chnl, memberCache, authorText)
            : null;

        const isInteraction = intData !== null,
            interactionData = intData ?? {};

        // 4. Render the actual text content of this message.
        const rawText = await renderMessageContent(item, context);

        // Mentions: Check if the current user should be highlighted.
        const isMentioned = detectMention(item, member, discordID, isReply, replyData);

        const startsNewGroup =
            !state.lastauthor ||
            !isSameAuthor(state.lastmember, state.lastauthor, currentMember, item.author) ||
            item.createdAt - state.lastdate > MESSAGE_GROUP_TIMEOUT_MS ||
            isReply ||
            isInteraction ||
            state.lastReply ||
            (currentIsDiscross && currentUserAgent !== state.lastUserAgent) ||
            (!currentIsDiscross && state.lastIsDiscross);

        // Apply "First" or "Merged" content templates.
        // First: Includes the message text and potential reactions.
        // Merged: Just appends the text below the previous message in the same group.
        const wrappedText = startsNewGroup
            ? renderTemplate(templates.firstMessageContent, { '{$MESSAGE_TEXT}': rawText })
            : renderTemplate(templates.mergedMessageContent, { '{$MESSAGE_TEXT}': rawText });

        if (state.currentmessage === '') state.isContinuationBlock = !startsNewGroup;

        // 5. Process Reactions.
        const reactionsHtml = processReactions(
            item.reactions,
            imagesCookie,
            templates.reactions,
            templates.reaction,
            animationsCookie
        );

        const hasEmbeds = !!(item.embeds?.length || item.embeds?.size);

        // Adjust reaction spacing if embeds are present.
        const finalReactionsHtml =
            hasEmbeds && reactionsHtml
                ? reactionsHtml.replace('class="reactions"', 'class="reactions embed-reactions"')
                : reactionsHtml;

        const withReactions = renderTemplate(wrappedText, {
            '{$MESSAGE_REACTIONS}': finalReactionsHtml,
        });

        // 6. Handle System Messages.
        const isSystem = !isNormalMessage(item.type);

        // Strip HTML to see if the message actually has visible content.
        const visibleText = rawText
            .replace(/<img\b[^>]*>/gi, 'x')
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        // Skip empty normal messages that have no attachments/embeds.
        if (
            !isSystem &&
            !isForwarded &&
            visibleText.length === 0 &&
            !(item.attachments?.size || item.attachments?.length) &&
            !(item.embeds?.length || item.embeds?.size) &&
            !(item.stickers?.size || item.stickers?.length)
        )
            continue;

        const messageHtml =
            isSystem && visibleText.length === 0
                ? renderTemplate(getTemplate('system-message', 'channel'), {
                      AUTHOR_NAME: escape(getDisplayName(currentMember, item.author)),
                      TEXT: SYSTEM_MESSAGE_TEXT[item.type] ?? 'performed an action',
                  })
                : withReactions;

        // 7. Update State for the next iteration.
        state.lastauthor = item.author;
        state.lastmember = currentMember;
        state.lastdate = item.createdAt;
        state.messageid = item.id;
        state.isForwarded = isForwarded;
        state.forwardData = forwardData;
        state.lastMentioned = isMentioned;
        state.lastReply = isReply;
        state.lastReplyData = replyData;
        state.lastForwarded = isForwarded;
        state.lastInteraction = isInteraction;
        state.lastInteractionData = interactionData;
        state.currentmessage += messageHtml;
        state.lastIsBot = !!item.author.bot;
        state.lastIsVerified = !!(
            item.author.verified ||
            (item.author.flags && item.author.flags.has(UserFlags.VerifiedBot))
        );
        state.lastIsWebhook = !!item.webhookId;
        state.lastIsInteraction = !!item.interaction;

        state.lastIsDiscross = currentIsDiscross;
        state.lastUserAgent = currentUserAgent;
    }
    // Cleanup anchors and add the final scrolling target.
    response = removeExistingEndAnchors(response);
    response += getTemplate('end-anchor', 'channel');
    return response;
};

/**
 * Main request handler for serving a Discord channel page.
 *
 * @param {object} bot - The bot instance.
 * @param {object} req - The HTTP request object.
 * @param {object} res - The HTTP response object.
 * @param {string[]} args - URL segments (e.g., ["channels", "guildID", "channelID"]).
 * @param {string} discordID - The authenticated user's Discord ID.
 */

exports.processChannel = async function processChannel(bot, req, res, args, discordID) {
    const parsedUrl = new URL(req.url, 'http://localhost');

    const urlSessionID = parsedUrl.searchParams.get('sessionID') ?? '',
        urlTheme = parsedUrl.searchParams.get('theme'),
        urlImages = parsedUrl.searchParams.get('images'),
        urlEmoji = parsedUrl.searchParams.get('emoji'),
        urlExpanded = parsedUrl.searchParams.get('expanded');

    const { images: cookieImages, whiteThemeCookie: cookieTheme } = parseCookies(req);

    const imagesCookie =
        urlImages !== null
            ? parseInt(urlImages, 10)
            : cookieImages !== undefined
              ? parseInt(cookieImages, 10)
              : 1;

    const theme = resolveTheme(req),
        { authorText, replyText, boxColor, barColor } = theme;

    if (!isBotReady(bot)) {
        res.writeHead(503, { 'Content-Type': 'text/html' });
        res.end(getTemplate('bot-not-connected', 'misc'));
        return;
    }

    const clientTimezone = getTimezoneFromIP(req),
        chnl = await bot.client.channels.fetch(args[2]).catch(() => undefined);

    if (!chnl) return notFound.serve404(req, res, 'Invalid channel.', '/', 'Back to Home');

    // Handle Skin Tone
    const { emojiSkinTone: cookieSkinTone } = parseCookies(req);
    const querySkinTone = parsedUrl.searchParams.get('skinTone');
    const skinTone = querySkinTone !== null ? querySkinTone : (cookieSkinTone || '');

    if (querySkinTone !== null) {
        res.setHeader('Set-Cookie', `emojiSkinTone=${querySkinTone}; Path=/; Max-Age=31536000`);
    }

    const sessionParam = buildSessionParam(
        urlSessionID,
        urlTheme,
        cookieTheme,
        urlImages,
        cookieImages,
        querySkinTone,
        cookieSkinTone
    );

    try {
        const botMember = await chnl.guild.members.fetch(bot.client.user.id).catch(() => null);

        if (!botMember) {
            res.writeHead(503, { 'Content-Type': 'text/html' });
            res.end(getTemplate('not-in-server', 'misc'));
            return;
        }

        const member = await chnl.guild.members.fetch(discordID).catch(() => null);

        if (!member) {
            res.writeHead(403, { 'Content-Type': 'text/html' });
            res.end(getTemplate('join-server-to-view', 'misc'));
            return;
        }

        const canView = await require('./utils.js').canViewChannel(member, botMember, chnl);

        if (!canView) {
            res.writeHead(403, { 'Content-Type': 'text/html' });
            res.end(getTemplate('no-permission', 'misc'));
            return;
        }

        // Fetch server emojis
        let serverEmojis = [];
        let serverEmojisJSON = '[]';
        if (chnl.guild && chnl.guild.emojis && chnl.guild.emojis.cache) {
            serverEmojis = chnl.guild.emojis.cache.map(e => ({
                id: e.id,
                name: e.name,
                animated: e.animated,
                url: e.imageURL()
            }));
            serverEmojisJSON = JSON.stringify(serverEmojis);
        }

        const {
            getQuickEmojiHTML,
            getExpandedEmojiHTML
        } = require('./emojiUtils');

        const baseTemplate = renderTemplate(getTemplate('channel', ''), {
            COMMON_HEAD: getTemplate('head', 'partials'),
            PAGE_CLASS: 'page-channel',
            EMOJI_PICKER: renderTemplate(getTemplate('emoji-picker', 'partials'), {
                SERVER_EMOJIS_JSON: serverEmojisJSON,
                SKINTONE_SELECTOR_HTML: getSkinToneSelectorHTML(chnl.id, urlEmoji === '1', urlExpanded === '1', sessionParam),
                SKIN_TONE: skinTone,
                EMOJI_OPEN: urlExpanded === '1' ? 'open' : '',
                EMOJI_EXPAND_URL: require('./utils.js').buildEmojiExpandUrl(chnl.id, urlExpanded === '1', sessionParam),
                EMOJI_QUICK_HTML: getQuickEmojiHTML(skinTone),
                EMOJI_EXPANDED_HTML: urlExpanded === '1' ? getExpandedEmojiHTML(skinTone, serverEmojis) : ''
            }),
            EMOJI_BUTTON: getTemplate('emoji-picker-button', 'partials'),
            CHANNEL_REPLY: '',
            REPLY_MESSAGE_ID_INPUT: '',
            WHITE_THEME_ENABLED: theme.themeClass,
            SERVER_ID: chnl.guild.id,
            CHANNEL_ID: chnl.id,
        });

        const inputHtml = !botMember
            .permissionsIn(chnl)
            .has(PermissionFlagsBits.ManageWebhooks, true)
            ? renderTemplate(getTemplate('input-disabled', 'channel'), {
                  COLOR: boxColor,
                  "You don't have permission to send messages in this channel.":
                      "Discross bot doesn't have the Manage Webhooks permission",
              })
            : member.permissionsIn(chnl).has(PermissionFlagsBits.SendMessages, true)
              ? renderTemplate(getTemplate('input', 'channel'), { COLOR: boxColor })
              : renderTemplate(getTemplate('input-disabled', 'channel'), { COLOR: boxColor });

        if (!member.permissionsIn(chnl).has(PermissionFlagsBits.ReadMessageHistory, true)) {
            const final = renderTemplate(baseTemplate, {
                INPUT: inputHtml,
                MESSAGES: getTemplate('no-message-history', 'channel'),
                CHANNEL_NAME: (chnl.isThread() ? '' : '#') + normalizeWeirdUnicode(chnl.name),
                SESSION_ID: urlSessionID,
                SESSION_PARAM: sessionParam,
                EMOJI_DISPLAY: urlEmoji === '1' ? '' : 'display: none;',
                EMOJI_TOGGLE_URL: buildEmojiToggleUrl(chnl.id, urlEmoji === '1', sessionParam),
            });
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(final);
            return;
        }

        const messagesHtml = await exports.buildMessagesHtml({
            bot,
            chnl,
            member,
            discordID,
            req,
            imagesCookie,
            animationsCookie: 1,
            authorText,
            replyText,
            barColor,
            clientTimezone,
            channelId: args[2],
        });

        const refreshUrl =
            chnl.id +
            '?random=' +
            Math.random() +
            (urlSessionID ? '&sessionID=' + encodeURIComponent(urlSessionID) : '');

        const final = renderTemplate(baseTemplate, {
            REFRESH_URL: refreshUrl,
            INPUT: inputHtml,
            RANDOM_EMOJI: RANDOM_EMOJIS[Math.floor(Math.random() * RANDOM_EMOJIS.length)],
            CHANNEL_NAME: (chnl.isThread() ? '' : '#') + normalizeWeirdUnicode(chnl.name),
            MESSAGES: messagesHtml,
            SESSION_ID: urlSessionID,
            SESSION_PARAM: sessionParam,
            EMOJI_DISPLAY: urlEmoji === '1' ? '' : 'display: none;',
            EMOJI_TOGGLE_URL: buildEmojiToggleUrl(chnl.id, urlEmoji === '1', sessionParam),
        });

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(final);
    } catch (err) {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        if ((err.message || err).toString().includes('error reading from remote stream')) {
            res.end(getTemplate('proxy-timeout-error', 'misc'));
        } else {
            res.end(getTemplate('generic-error', 'misc'));
        }
    }
};
