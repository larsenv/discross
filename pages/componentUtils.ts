'use strict';
const escape = require('escape-html');
const { renderDiscordMarkdown } = require('./discordMarkdown');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const { processUnicodeEmojiInText, cacheCustomEmoji } = require('./emojiUtils');
const { processEmojiInHTML, proxyExternalImageUrl, proxyExternalFileUrl } = require('./embedUtils');
const { renderMosaic, mosaicImage } = require('./mosaicUtils');
const { render, getTemplate } = require('./utils');

// Discord component types (https://discord.com/developers/docs/components/reference)
const ACTION_ROW = 1;
const BUTTON = 2;
const STRING_SELECT = 3;
const USER_SELECT = 5;
const ROLE_SELECT = 6;
const MENTIONABLE_SELECT = 7;
const CHANNEL_SELECT = 8;
const SECTION = 9;
const TEXT_DISPLAY = 10;
const THUMBNAIL = 11;
const MEDIA_GALLERY = 12;
const FILE = 13;
const SEPARATOR = 14;
const CONTAINER = 17;

const SELECT_TYPES = new Set([
    STRING_SELECT,
    USER_SELECT,
    ROLE_SELECT,
    MENTIONABLE_SELECT,
    CHANNEL_SELECT,
]);

const BUTTON_STYLES = {
    1: 'primary',
    2: 'secondary',
    3: 'success',
    4: 'danger',
    5: 'secondary',
    6: 'premium',
};

/** Message flag marking a Components V2 message (no content or embeds). */
const MESSAGE_FLAG_IS_COMPONENTS_V2 = 1 << 15;

/**
 * Raw API shape of a component, whether it came from discord.js (classes with
 * toJSON) or straight from the REST API (search results).
 */
function rawComponent(component) {
    if (!component) return null;
    if (typeof component.toJSON === 'function') return component.toJSON();
    return component;
}

function isComponentsV2(item) {
    const flags = item?.flags;
    if (flags == null) return false;
    if (typeof flags.has === 'function') return flags.has(MESSAGE_FLAG_IS_COMPONENTS_V2);
    const n = typeof flags === 'object' ? Number(flags.bitfield) : Number(flags);
    return Number.isFinite(n) && (n & MESSAGE_FLAG_IS_COMPONENTS_V2) !== 0;
}

function messageComponents(item) {
    const list = item?.components;
    if (!list) return [];
    return (Array.isArray(list) ? list : Array.from(list.values?.() ?? [])).map(rawComponent);
}

/**
 * Proxies a media URL from a component. Discord attachment URLs go through the
 * same path-based proxy as message attachments; anything else uses the
 * external proxy.
 */
function proxyMediaUrl(url, isImage) {
    if (!url || typeof url !== 'string') return '';
    if (/^https?:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\//i.test(url)) {
        return (isImage ? '/imageProxy/' : '/fileProxy/') + url.replace(/^(.*?)(\d+)/, '$2');
    }
    return isImage ? proxyExternalImageUrl(url) : proxyExternalFileUrl(url);
}

/** Resolves `attachment://name` references against the message's attachments. */
function resolveMedia(media, item) {
    const url = media?.url || media?.proxy_url || '';
    if (!url.startsWith('attachment://')) return url;
    const name = url.slice('attachment://'.length);
    const attachments = item?.attachments;
    const list = attachments?.values ? Array.from(attachments.values()) : attachments || [];
    const match = list.find((a) => (a.name || a.filename) === name);
    return match?.url || '';
}

function findAttachmentByUrl(url, item) {
    const attachments = item?.attachments;
    const list = attachments?.values ? Array.from(attachments.values()) : attachments || [];
    const path = (url || '').split('?')[0];
    return list.find((a) => (a.url || '').split('?')[0] === path) || null;
}

function renderComponentEmoji(emoji, ctx) {
    if (!emoji || ctx.imagesCookie !== 1) {
        return emoji?.name && !emoji.id ? escape(emoji.name) + ' ' : '';
    }
    if (emoji.id) {
        cacheCustomEmoji(emoji.id, emoji.name, !!emoji.animated);
        return render('channel/emoji-custom', {
            EMOJI_ID: emoji.id,
            EXT: emoji.animated && ctx.animationsCookie === 1 ? 'gif' : 'png',
            PX: '20',
            STYLE: 'width: 1.25em; height: 1.25em; vertical-align: -0.25em; margin-right: 4px;',
        });
    }
    return emoji.name ? processUnicodeEmojiInText(escape(emoji.name), 20, '1.25em') + ' ' : '';
}

function renderButton(button, ctx) {
    const style = BUTTON_STYLES[button.style] || 'secondary';
    const label =
        renderComponentEmoji(button.emoji, ctx) +
        (button.label ? escape(normalizeWeirdUnicode(button.label)) : '');
    if (button.style === 5 && button.url) {
        return render('components/link-button', {
            URL: escape(proxyExternalFileUrl(button.url)),
            LABEL: label,
            DISABLED: button.disabled ? ' component-disabled' : '',
        });
    }
    return render('components/button', {
        STYLE: style,
        LABEL: label || (button.style === 6 ? 'Premium' : '&nbsp;'),
        DISABLED: button.disabled ? ' component-disabled' : '',
    });
}

function renderSelect(select, ctx) {
    const defaults =
        select.type === STRING_SELECT
            ? (select.options || []).filter((o) => o.default)
            : (select.default_values || []).map(() => null);
    let text;
    if (select.type === STRING_SELECT && defaults.length) {
        text = defaults
            .map((o) => renderComponentEmoji(o.emoji, ctx) + escape(normalizeWeirdUnicode(o.label)))
            .join(', ');
    } else {
        text = escape(normalizeWeirdUnicode(select.placeholder || 'Make a selection'));
    }
    return render('components/select', {
        TEXT: text,
        PLACEHOLDER:
            select.type === STRING_SELECT && defaults.length ? '' : ' component-select-placeholder',
        DISABLED: select.disabled ? ' component-disabled' : '',
    });
}

function renderMediaTiles(items, ctx) {
    const tiles = items
        .map((entry) => {
            const url = resolveMedia(entry.media, ctx.item);
            return url ? mosaicImage(escape(proxyMediaUrl(url, true)), !!entry.spoiler) : '';
        })
        .filter(Boolean);
    if (tiles.length === 0) return '';
    if (tiles.length === 1) {
        const single = items.find((entry) => resolveMedia(entry.media, ctx.item));
        const url = escape(proxyMediaUrl(resolveMedia(single.media, ctx.item), true));
        return single.spoiler
            ? render('channel/spoiler-image', { IMAGE_URL: url }).replace(/^\s*<br\s*\/?>/i, '')
            : render('components/media', { IMAGE_URL: url });
    }
    return renderMosaic(tiles);
}

function renderFile(file, ctx) {
    const url = resolveMedia(file.file, ctx.item);
    if (!url) return '';
    const attachment = findAttachmentByUrl(url, ctx.item);
    const name =
        file.name ||
        attachment?.name ||
        attachment?.filename ||
        decodeURIComponent(url.split('?')[0].split('/').pop() || 'file');
    const size = file.size ?? attachment?.size ?? 0;
    return render('components/file', {
        CONTENT: ctx.renderFileCard(name, size, proxyMediaUrl(url, false)),
    });
}

function renderThumbnail(thumbnail, ctx) {
    if (ctx.imagesCookie !== 1) return '';
    const url = resolveMedia(thumbnail.media, ctx.item);
    if (!url) return '';
    return render('components/thumbnail', {
        CONTENT: mosaicImage(escape(proxyMediaUrl(url, true)), !!thumbnail.spoiler),
    });
}

function renderComponent(component, ctx) {
    if (!component) return '';
    switch (component.type) {
        case ACTION_ROW: {
            const children = (component.components || []).map(rawComponent);
            const html = children
                .map((child) =>
                    child.type === BUTTON
                        ? renderButton(child, ctx)
                        : SELECT_TYPES.has(child.type)
                          ? renderSelect(child, ctx)
                          : ''
                )
                .join('');
            return html ? render('components/action-row', { CONTENT: html }) : '';
        }
        case BUTTON:
            return renderButton(component, ctx);
        case TEXT_DISPLAY:
            return render('components/text', {
                CONTENT: processEmojiInHTML(
                    renderDiscordMarkdown(component.content || '', {
                        barColor: '#808080',
                        timezone: ctx.clientTimezone,
                    }),
                    ctx.imagesCookie,
                    ctx.animationsCookie
                ),
            });
        case SECTION: {
            const text = (component.components || [])
                .map((child) => renderComponent(rawComponent(child), ctx))
                .join('');
            const accessory = rawComponent(component.accessory);
            const accessoryHtml = !accessory
                ? ''
                : accessory.type === THUMBNAIL
                  ? renderThumbnail(accessory, ctx)
                  : renderComponent(accessory, ctx);
            return render('components/section', {
                TEXT: text,
                ACCESSORY: accessoryHtml
                    ? render('components/section-accessory', { CONTENT: accessoryHtml })
                    : '',
            });
        }
        case THUMBNAIL:
            return renderThumbnail(component, ctx);
        case MEDIA_GALLERY:
            if (ctx.imagesCookie !== 1) return '';
            return render('components/gallery', {
                CONTENT: renderMediaTiles(component.items || [], ctx),
            });
        case FILE:
            return renderFile(component, ctx);
        case SEPARATOR:
            return render('components/separator', {
                SPACING: component.spacing === 2 ? 'large' : 'small',
                LINE:
                    component.divider === false ? '' : getTemplate('separator-line', 'components'),
            });
        case CONTAINER: {
            const inner = (component.components || [])
                .map((child) => renderComponent(rawComponent(child), ctx))
                .join('');
            const color =
                typeof component.accent_color === 'number'
                    ? `#${component.accent_color.toString(16).padStart(6, '0')}`
                    : null;
            return render('components/container', {
                ACCENT: color ? ` style="border-left: 4px solid ${color};"` : '',
                SPOILER: component.spoiler ? ' component-container-spoiler' : '',
                SPOILER_CLICK: component.spoiler
                    ? getTemplate('container-spoiler-click', 'components').trim()
                    : '',
                CONTENT: inner,
            });
        }
        default:
            // Text inputs and labels only appear in modals; anything newer is skipped.
            return '';
    }
}

/**
 * Renders a message's components the way Discord shows them: buttons and
 * select menus under the message (Discross can't send interactions, so only
 * link buttons do anything), and Components V2 layouts (containers, sections,
 * text, media galleries, files and separators) as the message body.
 *
 * @param {object} item - The Discord message (discord.js or raw API shape)
 * @param {object} options
 * @param {number} options.imagesCookie
 * @param {number} options.animationsCookie
 * @param {string|null} options.clientTimezone
 * @param {(name: string, size: number, url: string) => string} options.renderFileCard
 * @returns {string}
 */
function renderComponents(item, options) {
    const components = messageComponents(item);
    if (components.length === 0) return '';
    const ctx = { ...options, item };
    const html = components.map((component) => renderComponent(component, ctx)).join('');
    return html ? render('components/wrapper', { CONTENT: html }) : '';
}

module.exports = { renderComponents, isComponentsV2, messageComponents };
