'use strict';
/**
 * Shared utility functions used across multiple page modules.
 */

/**
 * Replaces all occurrences of `needle` in `string` with `replacement`.
 * Built-in String.prototype.replace() only replaces the first occurrence.
 *
 * @param {string} string - The source string.
 * @param {string} needle - The substring to search for.
 * @param {string} [replacement=""] - The replacement value.
 * @returns {string}
 */
function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement ?? '');
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
    bot != null &&
    bot.client != null &&
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
  const raw = req.headers.cookie;
  if (!raw) return result;
  raw.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    result[parts.shift().trim()] = decodeURIComponent(parts.join('='));
  });
  return result;
}

/**
 * Theme configuration for dark (0), light (1), and AMOLED (2) themes.
 */
const THEME_CONFIG = {
  0: { boxColor: '#222327', authorText: '#72767d', replyText: '#b5bac1', themeClass: '' },
  1: {
    boxColor: '#ffffff',
    authorText: '#000000',
    replyText: '#000000',
    themeClass: 'class="light-theme"',
  },
  2: {
    boxColor: '#141416',
    authorText: '#72767d',
    replyText: '#b5bac1',
    themeClass: 'class="amoled-theme"',
  },
};

/** Random emoji codepoints used in the channel input area. */
const RANDOM_EMOJIS = ['1f62d', '1f480', '2764-fe0f', '1f44d', '1f64f', '1f389', '1f642'];

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

module.exports = {
  strReplace,
  isValidSnowflake,
  isBotReady,
  getBaseUrl,
  parseCookies,
  THEME_CONFIG,
  RANDOM_EMOJIS,
  buildSessionParam,
};
