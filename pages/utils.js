'use strict';
/**
 * Shared utility functions used across multiple page modules.
 */

const https = require('https');
const fs = require('fs');

/**
 * Loads a component template from the pages/templates folder.
 *
 * @param {string} name - The name of the template file (without .html).
 * @param {string} [folder="channel"] - The subfolder within pages/templates.
 * @returns {string} The template content.
 */
function getTemplate(name, folder = 'channel') {
    const filePath = `pages/templates/${folder}/${name}.html`;
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        // Remove #end comments that might be present in some templates
        return content.replace(/#end(?=["'])/g, '');
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
    const headPartial = getTemplate('head', 'partials');
    const mainTemplate = getTemplate(name, folder);
    const templateWithHead = renderTemplate(mainTemplate, { COMMON_HEAD: headPartial });
    return renderTemplate(templateWithHead, data);
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

    // Global template variables
    const globalData = {
        DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
        DISCORD_REDIRECT_URL: process.env.DISCORD_REDIRECT_URL,
        DISCORD_REDIRECT_URL_ENCODED: encodeURIComponent(process.env.DISCORD_REDIRECT_URL || ''),
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
    return scheme + '://' + (req.headers.host || 'localhost');
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
    const parsedurl = new URL(req.url, 'http://localhost');
    const urlTheme = parsedurl.searchParams.get('theme');
    const cookieHeader = req.headers.cookie || '';
    const cookieTheme = cookieHeader.split('; ').find((c) => c.startsWith('whiteThemeCookie='));
    const cookieVal = cookieTheme ? cookieTheme.split('=')[1] : undefined;
    const theme =
        urlTheme !== null
            ? parseInt(urlTheme, 10)
            : cookieVal !== undefined
              ? parseInt(cookieVal, 10)
              : 0;
    if (theme === 1) return 'class="light-theme"';
    if (theme === 2) return 'class="amoled-theme"';
    return 'bgcolor="303338"';
}

/**
 * Resolves the active theme config entry from URL params + cookies.
 * Returns the full THEME_CONFIG entry (boxColor, authorText, replyText, themeClass)
 * for the active theme: URL `?theme=` takes priority over `whiteThemeCookie` cookie.
 *
 * Used by channel, channel_reply, draw, guest, pins, and news page handlers.
 *
 * @param {object} req - Node.js IncomingMessage.
 * @returns {{ boxColor: string, authorText: string, replyText: string, themeClass: string }}
 */
function resolveTheme(req) {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const urlTheme = parsedUrl.searchParams.get('theme');
    const cookieTheme = req.headers.cookie
        ?.split('; ')
        ?.find((c) => c.startsWith('whiteThemeCookie='))
        ?.split('=')[1];
    const themeValue =
        urlTheme !== null
            ? parseInt(urlTheme, 10)
            : cookieTheme !== undefined
              ? parseInt(cookieTheme, 10)
              : 0;
    return { ...(THEME_CONFIG[themeValue] ?? THEME_CONFIG[0]), themeValue };
}

/**
 * Builds the combined URL query string for session/theme/images link params.
 * Preference params (theme/images) are only included when the browser has not
 * set the corresponding cookie (i.e. the browser does not support cookies).
 *
 * @param {string} urlSessionID - Session ID from URL params.
 * @param {string|null} urlTheme - Theme value from URL params (null if absent).
 * @param {string|undefined} cookieTheme - whiteThemeCookie value (undefined if absent).
 * @param {string|null} urlImages - Images preference from URL params (null if absent).
 * @param {string|undefined} cookieImages - images cookie value (undefined if absent).
 * @returns {string} Query string (e.g. "?sessionID=abc&theme=1") or empty string.
 */
function buildSessionParam(urlSessionID, urlTheme, cookieTheme, urlImages, cookieImages) {
    const parts = [];
    if (urlSessionID) parts.push('sessionID=' + encodeURIComponent(urlSessionID));
    if (urlTheme !== null && cookieTheme === undefined)
        parts.push('theme=' + encodeURIComponent(urlTheme));
    if (urlImages !== null && cookieImages === undefined)
        parts.push('images=' + encodeURIComponent(urlImages));
    return parts.length ? '?' + parts.join('&') : '';
}

/**
 * Builds a URL that toggles the emoji picker open/closed while preserving other
 * query parameters (session, theme, images).
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
    return baseUrl + '?emoji=1' + (sessionParam ? sessionParam.replace('?', '&') : '');
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
    // Collect matches upfront so we iterate the original match list even as `result` changes.
    const matches = [...result.matchAll(regex)];
    for (const m of matches) {
        const mentioneduser =
            guild.members.cache.find((member) => member.user.tag === m[1]) ??
            (await guild.members
                .fetch()
                .then((members) => members.find((member) => member.user.tag === m[1]))
                .catch((err) => {
                    console.error('Failed to fetch members for mention:', err);
                    return null;
                }));
        if (mentioneduser) {
            result = result.replaceAll(m[0], `<@${mentioneduser.id}>`);
        }
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
    const { PermissionFlagsBits, ChannelType } = require('discord.js');

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

module.exports = {
    getTemplate,
    renderTemplate,
    loadAndRenderPageTemplate,
    isValidSnowflake,
    isBotReady,
    getBaseUrl,
    parseCookies,
    getPageThemeAttr,
    resolveTheme,
    THEME_CONFIG,
    RANDOM_EMOJIS,
    buildSessionParam,
    buildEmojiToggleUrl,
    sanitizeGuestName,
    resolveMentions,
    httpsGet,
    formatChangePct,
    changeColor,
    reportError,
    canViewChannel,
};
