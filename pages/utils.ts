'use strict';
/**
 * Shared utility functions used across multiple page modules.
 */

const https = require('https');
const fs = require('fs');

/**
 * Cache-busting token for the stylesheet, derived from main.css's mtime.
 *
 * Legacy console browsers (DSi/3DS Opera, PS3, etc.) cache /css/main.css very
 * aggressively — max-age=3600 with no version param means they can serve a
 * stale stylesheet for an hour or more and won't revalidate on reload. That
 * makes CSS fixes appear not to take effect on the device. Appending ?v=<mtime>
 * forces a re-fetch whenever the file changes, while unrelated deploys (which
 * don't touch main.css) keep the same token and the cache stays warm.
 */
const CSS_VERSION = (function () {
    try {
        return String(Math.trunc(fs.statSync('pages/static/css/main.css').mtimeMs));
    } catch (err) {
        // If the file can't be stat'd, fall back to process start time.
        return String(Date.now());
    }
})();

/**
 * Cache-busting token for draw.js, derived from its mtime.
 *
 * The Wii Internet Channel (Opera 9) caches /js/draw.js extremely aggressively.
 * Without a version query string, the Wii won't re-fetch the script even after
 * server-side fixes are deployed, making all JS changes invisible to the device.
 */
const DRAW_JS_VERSION = (function () {
    try {
        return String(Math.trunc(fs.statSync('pages/static/js/draw.js').mtimeMs));
    } catch (err) {
        return String(Date.now());
    }
})();

const CHANNEL_JS_VERSION = (function () {
    try {
        return String(Math.trunc(fs.statSync('pages/static/js/channel.js').mtimeMs));
    } catch (err) {
        return String(Date.now());
    }
})();

/**
 * Loads a component template from the pages/templates folder.
 *
 * @param {string} name - The name of the template file (without .html).
 * @param {string} [folder="channel"] - The subfolder within pages/templates.
 * @returns {string} The template content.
 */
function getTemplate(name, folder = 'channel') {
    const folderPath = folder ? `${folder}/` : '';
    const filePath = `pages/templates/${folderPath}${name}.html`;
    try {
        let content = fs.readFileSync(filePath, 'utf-8');
        // Remove #end comments that might be present in some templates
        content = content.replace(/#end(?=["'])/g, '');
        // Cache-bust the stylesheet so legacy browsers re-fetch it when it changes.
        content = content.replace('/css/main.css', `/css/main.css?v=${CSS_VERSION}`);
        // Cache-bust JS files for Wii Opera 9 which ignores max-age headers.
        content = content.replace('/js/draw.js"', `/js/draw.js?v=${DRAW_JS_VERSION}"`);
        content = content.replace('/js/channel.js"', `/js/channel.js?v=${CHANNEL_JS_VERSION}"`);
        return content;
    } catch (err) {
        console.error(`Failed to load template ${filePath}:`, err);
        return '';
    }
}

/**
 * Loads and renders a full page template, including the common head partial.
 *
 * @param {string} name - The name of the template file (without .html).
 * @param {string} [folder=""] - The subfolder within pages/templates.
 * @param {object} [data={}] - A map of placeholder keys to replacement values.
 * @returns {string} The rendered page content.
 */
function loadAndRenderPageTemplate(name, folder = '', data = {}) {
    const path = folder ? `${folder}/${name}` : `/${name}`;
    return render(path, data);
}

/**
 * Replaces multiple template placeholders in a string.
 *
 * @param {string} template - The template string with {$PLACEHOLDER} tags.
 * @param {Object.<string, string>} data - A map of placeholder keys to replacement values.
 * @returns {string} The rendered template.
 */
function renderTemplate(template, data) {
    if (!template) return '';
    if (!data) data = {};

    const isCachingPass = Object.keys(data).length === 0;

    // Global template variables
    const globalData = {
        DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
        DISCORD_REDIRECT_URL: (process.env.DISCORD_REDIRECT_URL || '').trim(),
        DISCORD_REDIRECT_URL_ENCODED: encodeURIComponent(
            (process.env.DISCORD_REDIRECT_URL || '').trim()
        ),
        PAGE_TITLE:
            data.PAGE_TITLE ??
            (isCachingPass ? '{$PAGE_TITLE}' : 'Discross - Use Discord Anywhere'),
        SEO_METADATA: data.SEO_METADATA ?? (isCachingPass ? '{$SEO_METADATA}' : ''),
        COMMON_HEAD: getTemplate('head', 'partials'),
    };

    // Merge global data with provided data (provided data takes precedence)
    const mergedData = { ...globalData, ...data };

    let result = template;
    for (const [key, value] of Object.entries(mergedData)) {
        // Normalize key: remove surrounding {$$} if present
        let normalizedKey = key;
        if (normalizedKey.startsWith('{$') && normalizedKey.endsWith('}')) {
            normalizedKey = normalizedKey.slice(2, -1);
        }
        const placeholder = `{$${normalizedKey}}`;
        result = result.split(placeholder).join(value ?? '');
    }

    // Secondary pass for global templates that might have injected more placeholders
    if (result.includes('{$PAGE_TITLE}')) {
        result = result
            .split('{$PAGE_TITLE}')
            .join(
                data.PAGE_TITLE ??
                    (isCachingPass ? '{$PAGE_TITLE}' : 'Discross - Use Discord Anywhere')
            );
    }
    if (result.includes('{$SEO_METADATA}')) {
        result = result
            .split('{$SEO_METADATA}')
            .join(data.SEO_METADATA ?? (isCachingPass ? '{$SEO_METADATA}' : ''));
    }

    return result;
}

/**
 * Returns true if `id` is a plausible Discord snowflake (16-20 decimal digits).
 *
 * @param {string} id
 * @returns {boolean}
 */
function isValidSnowflake(id) {
    return typeof id === 'string' && /^[0-9]{16,20}$/.test(id);
}

/**
 * Returns true if the Discord bot client is ready to serve requests.
 *
 * @param {object} bot - The bot module object.
 * @returns {boolean}
 */
function isBotReady(bot) {
    return (
        bot !== null &&
        bot !== undefined &&
        bot.client !== null &&
        bot.client !== undefined &&
        (typeof bot.client.isReady === 'function' ? bot.client.isReady() : !!bot.client.uptime)
    );
}

/**
 * Constructs the base URL (scheme + host) from an incoming HTTP request.
 *
 * @param {object} req - Node.js IncomingMessage.
 * @returns {string}
 */
function getBaseUrl(req) {
    const scheme = req.socket && req.socket.encrypted ? 'https' : 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    return scheme + '://' + host;
}

/**
 * Generates SEO metadata HTML (meta tags, JSON-LD, canonical).
 *
 * @param {object} req - Node.js IncomingMessage.
 * @param {object} options - SEO options (title, description, canonical, type, image).
 * @returns {string}
 */
function generateSEOMetadata(req, options = {}) {
    const baseUrl = getBaseUrl(req);
    const path = new URL(req.url, 'http://localhost').pathname;
    const url = baseUrl + path;

    const title = options.title || 'Discross - Use Discord Anywhere';
    const description =
        options.description ||
        'Discross is a universal Discord client that brings modern communication to any device with a web browser. Access Discord, check weather, read news, view sports scores, and more on everything from retro consoles to modern smartphones.';
    const canonical = options.canonical || url;
    const type = options.type || 'website';
    const image = options.image || baseUrl + '/resources/logo_full.png';
    const siteName = 'Discross';

    let html = `
    <meta name="description" content="${escapeHtml(description)}" />
    <link rel="canonical" href="${escapeHtml(canonical)}" />
    ${options.noindex ? '<meta name="robots" content="noindex" />' : ''}

    <!-- Open Graph -->
    <meta property="og:type" content="${escapeHtml(type)}" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:image" content="${escapeHtml(image)}" />
    <meta property="og:url" content="${escapeHtml(url)}" />
    <meta property="og:site_name" content="${escapeHtml(siteName)}" />

    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${escapeHtml(image)}" />
    `;

    // JSON-LD Structured Data
    const jsonLd = {
        '@context': 'https://schema.org',
        '@type': options.schemaType || 'WebApplication',
        name: siteName,
        url: baseUrl,
        description: description,
        applicationCategory: 'CommunicationApplication',
        operatingSystem: 'Any with a web browser',
        softwareVersion: '1.0.0',
        offers: {
            '@type': 'Offer',
            price: '0',
            priceCurrency: 'USD',
        },
    };

    if (options.schemaExtra) {
        Object.assign(jsonLd, options.schemaExtra);
    }

    html += `\n    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`;

    return html;
}

function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Parses the Cookie header of a request into a plain object.
 *
 * @param {object} req - Node.js IncomingMessage.
 * @returns {Record<string, string>}
 */
function parseCookies(req) {
    const result = {};
    const raw = req?.headers?.cookie;
    if (!raw) return result;
    raw.split(';').forEach((cookie) => {
        const parts = cookie.split('=');
        const key = parts.shift().trim();
        const val = parts.join('=');
        try {
            result[key] = decodeURIComponent(val);
        } catch (e) {
            result[key] = val; // Fallback to raw value if decoding fails
        }
    });
    return result;
}

/**
 * Theme configuration for dark (0), light (1), and AMOLED (2) themes.
 */
const THEME_CONFIG = {
    0: {
        boxColor: '#222327',
        authorText: '#ffffff',
        replyText: '#b5bac1',
        barColor: '#808080',
    },
    1: {
        boxColor: '#ffffff',
        authorText: '#000000',
        replyText: '#000000',
        barColor: '#808080',
        themeClass: 'class="light-theme"',
    },
    2: {
        boxColor: '#141416',
        authorText: '#ffffff',
        replyText: '#b5bac1',
        barColor: '#808080',
        themeClass: 'class="amoled-theme"',
    },
};

/** Random emoji codepoints used in the channel input area. */
const RANDOM_EMOJIS = ['1f62d', '1f480', '2764-fe0f', '1f44d', '1f64f', '1f389', '1f642'];

/**
 * Resolves the active theme index (0=dark, 1=light, 2=amoled) from a request,
 * reading the `theme` URL param first and falling back to the `whiteThemeCookie`
 * cookie. Unrecognized or absent values resolve to 0 (dark). Single source of
 * truth shared by getPageThemeAttr() and resolveTheme().
 *
 * @param {object} req - Node.js IncomingMessage.
 * @returns {number}
 */
function resolveThemeValue(req) {
    const urlTheme = new URL(req.url, 'http://localhost').searchParams.get('theme');
    if (urlTheme !== null) {
        const n = parseInt(urlTheme, 10);
        return Number.isNaN(n) ? 0 : n;
    }
    const cookieEntry = (req.headers.cookie || '')
        .split(';')
        .map((c) => c.trim())
        .find((c) => c.startsWith('whiteThemeCookie='));
    if (cookieEntry) {
        const n = parseInt(cookieEntry.slice('whiteThemeCookie='.length), 10);
        return Number.isNaN(n) ? 0 : n;
    }
    return 0;
}

/**
 * Resolves the HTML attribute value for the `{$WHITE_THEME_ENABLED}` template placeholder,
 * reading the `theme` URL param first, then the `whiteThemeCookie` cookie as fallback.
 * Returns `class="light-theme"` (1), `class="amoled-theme"` (2), or `bgcolor="303338"` (dark/default).
 *
 * Used by simple/auth pages (login, register, forgot, terms, privacy, index, notFound, food).
 *
 * @param {object} req - Node.js IncomingMessage.
 * @returns {string}
 */
function getPageThemeAttr(req) {
    const theme = resolveThemeValue(req);
    if (theme === 1) return 'class="light-theme"';
    if (theme === 2) return 'class="amoled-theme"';
    return 'bgcolor="#303338"';
}

/**
 * Resolves the active theme config entry from URL params + cookies.
 * Returns the full THEME_CONFIG entry (boxColor, authorText, replyText, themeClass)
 * for the active theme: URL `?theme=` takes priority over `whiteThemeCookie` cookie.
 *
 * Used by channel, channelReply, draw, guest, pins, and news page handlers.
 *
 * @param {object} req - Node.js IncomingMessage.
 * @returns {{ boxColor: string, authorText: string, replyText: string, themeClass: string }}
 */
function resolveTheme(req) {
    const themeValue = resolveThemeValue(req);
    return { ...(THEME_CONFIG[themeValue] ?? THEME_CONFIG[0]), themeValue };
}

/**
 * Builds the combined URL query string for session/theme/images/skinTone link params.
 * Preference params (theme/images/skinTone) are only included when the browser has not
 * set the corresponding cookie (i.e. the browser does not support cookies).
 *
 * @param {string} urlSessionID - Session ID from URL params.
 * @param {string|null} urlTheme - Theme value from URL params (null if absent).
 * @param {string|undefined} cookieTheme - whiteThemeCookie value (undefined if absent).
 * @param {string|null} urlImages - Images preference from URL params (null if absent).
 * @param {string|undefined} cookieImages - images cookie value (undefined if absent).
 * @param {string|null} urlSkinTone - Skin tone preference from URL params (null if absent).
 * @param {string|undefined} cookieSkinTone - emojiSkinTone cookie value (undefined if absent).
 * @returns {string} Query string (e.g. "?sessionID=abc&theme=1") or empty string.
 */
function buildSessionParam(
    urlSessionID,
    urlTheme,
    cookieTheme,
    urlImages,
    cookieImages,
    urlSkinTone = null,
    cookieSkinTone = undefined
) {
    const parts = [];
    if (urlSessionID) parts.push('sessionID=' + encodeURIComponent(urlSessionID));
    if (urlTheme !== null && cookieTheme === undefined)
        parts.push('theme=' + encodeURIComponent(urlTheme));
    if (urlImages !== null && cookieImages === undefined)
        parts.push('images=' + encodeURIComponent(urlImages));
    // Always include skinTone in URL if provided, to ensure refreshes work correctly
    if (urlSkinTone) parts.push('skinTone=' + encodeURIComponent(urlSkinTone));
    return parts.length ? '?' + parts.join('&') : '';
}

/**
 * Builds a URL that toggles the emoji picker open/closed while preserving other
 * query parameters (session, theme, images, skinTone).
 *
 * @param {string} baseUrl - Relative URL of the current page (e.g. channel ID).
 * @param {boolean} emojiOpen - Whether the emoji picker is currently open.
 * @param {string} sessionParam - Existing session/preference query string (from buildSessionParam).
 * @returns {string} URL with `emoji=1` added (to open) or removed (to close).
 */
function buildEmojiToggleUrl(baseUrl, emojiOpen, sessionParam) {
    if (emojiOpen) {
        return baseUrl + sessionParam;
    }
    return baseUrl + (sessionParam ? sessionParam + '&emoji=1' : '?emoji=1');
}

/**
 * Builds a URL that expands the emoji picker while preserving other
 * query parameters (session, theme, images, skinTone, emoji).
 *
 * @param {string} baseUrl - Relative URL of the current page (e.g. channel ID).
 * @param {boolean} expanded - Whether the emoji picker is currently expanded.
 * @param {string} sessionParam - Existing session/preference query string (from buildSessionParam).
 * @returns {string} URL with `expanded=1` added (to expand) or removed (to collapse).
 */
function buildEmojiExpandUrl(baseUrl, expanded, sessionParam) {
    const separator = sessionParam ? '&' : '?';
    const base = baseUrl + (sessionParam || '');

    // Ensure emoji=1 is present
    let url = base;
    if (!url.includes('emoji=1')) {
        url += (url.includes('?') ? '&' : '?') + 'emoji=1';
    }

    if (expanded) {
        // Already expanded, so the button should collapse it (remove expanded=1)
        return url.replace(/[&?]expanded=1/, '').replace('?&', '?');
    }
    // Not expanded, so the button should expand it
    return url + (url.includes('?') ? '&' : '?') + 'expanded=1';
}

/**
 * Strips non-printable / potentially dangerous characters from a Discord guest name.
 *
 * @param {string} name - Raw input name.
 * @returns {string} Sanitized name (max 32 chars, only printable Unicode).
 */
function sanitizeGuestName(name) {
    if (!name || typeof name !== 'string') return '';
    return name
        .replace(/[^\p{L}\p{N}\p{P}\p{Z}]/gu, '')
        .trim()
        .slice(0, 32);
}

/**
 * Format percentage change for display (e.g., "+1.23%" or "-4.56%")
 * @param {number|null} pct - Percentage change value
 * @returns {string} Formatted percentage string
 */
function formatChangePct(pct) {
    if (pct === null) return '--';
    const sign = pct >= 0 ? '+' : '';
    return sign + pct.toFixed(2) + '%';
}

/**
 * Get color based on positive/negative change
 * @param {number|null} change - Change value
 * @returns {string} Color hex code (green for positive, red for negative, gray for null)
 */
function changeColor(change) {
    if (change === null) return '#72767d';
    return change >= 0 ? '#57f287' : '#ed4245';
}

/**
 * Resolves @User#1234 mention tags in a message to proper Discord <@id> mentions.
 * Falls back gracefully (skips unresolvable mentions) and never throws.
 *
 * @param {string} text - Message text (after emoji conversion).
 * @param {import('discord.js').Guild} guild - The Discord guild to resolve members in.
 * @returns {Promise<string>} Text with @User#1234 patterns replaced by <@id> mention syntax.
 */
async function resolveMentions(text, guild) {
    const regex = /@([^#]{2,32}#\d{4})/g;
    let result = text;
    const matches = [...result.matchAll(regex)];
    if (matches.length === 0) return result;

    // Deduplicate the tags to resolve, then satisfy as many as possible from the
    // member cache. Only fall back to a (potentially expensive) full member fetch
    // if some tags remain — and do it exactly once for the whole message rather
    // than once per mention as the previous implementation did.
    const tags = [...new Set(matches.map((m) => m[1]))];
    const resolved = new Map(); // tag -> member id
    const unresolved = [];
    for (const tag of tags) {
        const cached = guild.members.cache.find((member) => member.user.tag === tag);
        if (cached) resolved.set(tag, cached.id);
        else unresolved.push(tag);
    }

    if (unresolved.length > 0) {
        try {
            const members = await guild.members.fetch();
            for (const tag of unresolved) {
                const found = members.find((member) => member.user.tag === tag);
                if (found) resolved.set(tag, found.id);
            }
        } catch (err) {
            console.error('Failed to fetch members for mention:', err);
        }
    }

    // Unresolvable mentions are left untouched (graceful fallback).
    for (const [tag, id] of resolved) {
        result = result.replaceAll(`@${tag}`, `<@${id}>`);
    }
    return result;
}

/**
 * Make an HTTPS GET request following up to `maxRedirects` redirects.
 * Resolves with `{ statusCode, body }` on success; rejects on network errors.
 *
 * @param {object} options - Node.js https.request options
 * @param {number} maxRedirects - Maximum number of redirects to follow
 * @returns {Promise<{statusCode: number, body: string}>}
 */
function httpsGet(options, maxRedirects) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            const status = res.statusCode;
            if (status >= 300 && status < 400 && res.headers.location && maxRedirects > 0) {
                res.resume(); // Discard body
                const newLoc = (() => {
                    try {
                        const loc = new URL(res.headers.location);
                        return Object.assign({}, options, {
                            hostname: loc.hostname,
                            path: loc.pathname + loc.search,
                        });
                    } catch (e) {
                        // Relative redirect — keep existing hostname
                        return Object.assign({}, options, { path: res.headers.location });
                    }
                })();
                return httpsGet(newLoc, maxRedirects - 1)
                    .then(resolve)
                    .catch(reject);
            }
            let body = '';
            res.on('data', (chunk) => {
                body += chunk;
            });
            res.on('end', () => resolve({ statusCode: status, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Verifies if a user has permission to view a channel, including thread membership check
 * and restricting discussion-based channels (Forum/Media).
 *
 * @param {import('discord.js').GuildMember} member - The user member.
 * @param {import('discord.js').GuildMember} botMember - The bot member.
 * @param {import('discord.js').BaseGuildTextChannel|import('discord.js').AnyThreadChannel} chnl - The channel.
 * @returns {Promise<boolean>} True if viewable, false otherwise.
 */
async function canViewChannel(member, botMember, chnl) {
    const { PermissionFlagsBits, ChannelType } = require('discord');

    if (!botMember || !chnl) return false;

    // Bot must always be able to view
    if (!botMember.permissionsIn(chnl).has(PermissionFlagsBits.ViewChannel, true)) return false;

    // If a member is provided, they must also be able to view
    if (member && !member.permissionsIn(chnl).has(PermissionFlagsBits.ViewChannel, true))
        return false;

    // Discussion based channels (Forum/Media) are not directly viewable in this app
    if (chnl.type === ChannelType.GuildForum || chnl.type === ChannelType.GuildMedia) {
        return false;
    }

    // Thread membership check: if member is provided, they must be a member to view
    if (chnl.isThread() && member) {
        try {
            await chnl.members.fetch(member.id);
            return true;
        } catch {
            return false;
        }
    }

    return true;
}

function reportError(message, error) {
    console.error(message, error);
}

/**
 * Loads and renders a template in one call.
 *
 * @param {string} path - Template path (e.g. 'channel/input' or 'input'). Defaults to 'channel/' if no folder specified.
 * @param {object} [data={}] - Data to inject into the template.
 * @returns {string} The rendered HTML.
 */
function render(path, data = {}) {
    let parts;
    const isAbsolute = path.startsWith('/');

    if (isAbsolute) {
        parts = path.substring(1).split('/');
    } else {
        parts = path.split('/');
    }

    if (parts.length === 1 && !isAbsolute) {
        // Default to 'channel' folder for simple paths like 'input'
        return renderTemplate(getTemplate(parts[0], 'channel'), data);
    }

    // Last part is the filename, everything before is the folder path
    const name = parts.pop();
    const folder = parts.join('/');

    // If absolute, folder can be empty (top-level). If relative, default to 'channel'.
    const finalFolder = isAbsolute ? folder : folder || 'channel';
    return renderTemplate(getTemplate(name, finalFolder), data);
}

module.exports = {
    getTemplate,
    renderTemplate,
    render,
    loadAndRenderPageTemplate,
    generateSEOMetadata,
    isValidSnowflake,
    isBotReady,
    getBaseUrl,
    parseCookies,
    getPageThemeAttr,
    resolveTheme,
    resolveThemeValue,
    THEME_CONFIG,
    RANDOM_EMOJIS,
    buildSessionParam,
    buildEmojiToggleUrl,
    buildEmojiExpandUrl,
    sanitizeGuestName,
    resolveMentions,
    httpsGet,
    formatChangePct,
    changeColor,
    reportError,
    canViewChannel,
};
