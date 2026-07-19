'use strict';

/**
 * User-Agent Utility for parsing client device/browser information.
 */

const clientCache = new Map();

const CLIENTS = [
    { id: 'new3ds', name: 'New Nintendo 3DS', keywords: ['New Nintendo 3DS'] },
    { id: '3ds', name: 'Nintendo 3DS', keywords: ['Nintendo 3DS'], isLegacy: true },
    { id: 'dsi', name: 'Nintendo DSi', keywords: ['Nintendo DSi'], isLegacy: true },
    { id: 'ds', name: 'Nintendo DS', keywords: ['Nitro'], isLegacy: true },
    { id: 'wiiu', name: 'Nintendo Wii U', keywords: ['Nintendo WiiU'] },
    { id: 'wii', name: 'Nintendo Wii', keywords: ['Nintendo Wii'], isLegacy: true },
    { id: 'switch', name: 'Nintendo Switch', keywords: ['Nintendo Switch'] },
    {
        id: 'ps2',
        name: 'PlayStation 2',
        keywords: ['PlayStation2', 'Playstation2', 'PS2', 'EGBrowser'],
        isLegacy: true,
    },
    { id: 'ps3', name: 'PlayStation 3', keywords: ['PLAYSTATION 3'], isLegacy: true },
    { id: 'ps4', name: 'PlayStation 4', keywords: ['PlayStation 4'] },
    { id: 'psp', name: 'PSP', keywords: ['PSP (PlayStation Portable)', 'PlayStation Portable'], isLegacy: true },
    { id: 'psvita', name: 'PlayStation Vita', keywords: ['PlayStation Vita'], isLegacy: true },
    { id: 'xbox360', name: 'Xbox 360', keywords: ['Xbox 360', 'Xbox'], isLegacy: true },
    { id: 'xboxone', name: 'Xbox One', keywords: ['Xbox One'] },
    { id: 'saturn', name: 'Sega Saturn', keywords: ['Sega Saturn'], isLegacy: true },
    {
        id: 'dreamcast',
        name: 'Sega Dreamcast',
        keywords: ['Sega Dreamcast', 'Planetweb', 'DreamKey'],
        isLegacy: true,
    },
    { id: 'arc', name: 'Arc', keywords: ['Arc/'] },
    { id: 'atlas', name: 'Atlas', keywords: ['ChatGPT Atlas', 'ChatGPT%20Atlas'] },
    { id: 'brave', name: 'Brave', keywords: ['Brave/'] },
    { id: 'chromium', name: 'Chromium', keywords: ['Chromium/'] },
    { id: 'vivaldi', name: 'Vivaldi', keywords: ['Vivaldi/', 'Vivaldi'] },
    { id: 'yandex', name: 'Yandex Browser', keywords: ['YaBrowser/'] },
    { id: 'edgebeta', name: 'Microsoft Edge Beta', keywords: ['EdgB/'] },
    { id: 'edgedev', name: 'Microsoft Edge Dev', keywords: ['EdgD/'] },
    { id: 'edge', name: 'Microsoft Edge', keywords: ['Edge/', 'Edg/', 'EdgA/', 'EdgiOS/'] },
    { id: 'edgecanary', name: 'Microsoft Edge Canary', keywords: ['Canary/'] },
    // SeaMonkey, Pale Moon, Basilisk, and K-Meleon all embed a "Firefox/" token
    // in their UA (they're Gecko/Goanna-based), so they must be checked before
    // the generic 'firefox' entry below or they'd always be misidentified as
    // plain Firefox.
    { id: 'seamonkey', name: 'SeaMonkey', keywords: ['SeaMonkey/'] },
    {
        id: 'palemoon',
        name: 'Pale Moon',
        keywords: ['PaleMoon/', 'Pale Moon/'],
        isLegacy: true,
    },
    { id: 'basilisk', name: 'Basilisk', keywords: ['Basilisk/'], isLegacy: true },
    { id: 'kmeleon', name: 'K-Meleon', keywords: ['K-Meleon/'], isLegacy: true },
    { id: 'firefox', name: 'Firefox', keywords: ['Firefox/'] },
    { id: 'duckduckgo', name: 'DuckDuckGo', keywords: ['DuckDuckGo/'] },
    { id: 'icab', name: 'iCab', keywords: ['iCab/'] },
    // AOL Explorer wraps Trident (IE) and would otherwise match 'ie' below.
    { id: 'aol', name: 'AOL Explorer', keywords: ['AOL '], isLegacy: true },
    { id: 'ie', name: 'Internet Explorer', keywords: ['MSIE ', 'Trident/'], isLegacy: true },
    { id: 'kindle', name: 'Kindle', keywords: ['Kindle/', 'Silk/'], isLegacy: true },
    { id: 'librewolf', name: 'LibreWolf', keywords: ['LibreWolf/'] },
    { id: 'konqueror', name: 'Konqueror', keywords: ['Konqueror/'] },
    { id: 'maxthon', name: 'Maxthon', keywords: ['Maxthon'] },
    { id: 'midori', name: 'Midori', keywords: ['Midori/'] },
    { id: 'camino', name: 'Camino', keywords: ['Camino/'], isLegacy: true },
    { id: 'netsurf', name: 'NetSurf', keywords: ['NetSurf/'], isLegacy: true },
    // Netscape 6+ tags itself with "Netscape/"; earlier Netscape 2-4 identified
    // purely as "Mozilla/x.x" and can't be distinguished from that string alone.
    { id: 'netscape', name: 'Netscape Navigator', keywords: ['Netscape/'], isLegacy: true },
    { id: 'mosaic', name: 'NCSA Mosaic', keywords: ['NCSA_Mosaic', 'Mosaic/'], isLegacy: true },
    { id: 'links', name: 'Links', keywords: ['Links ', 'Links/'], isLegacy: true },
    { id: 'operagx', name: 'Opera GX', keywords: ['OPRGX/'] },
    { id: 'operamini', name: 'Opera Mini', keywords: ['Opera Mini/'], isLegacy: true },
    { id: 'operatouch', name: 'Opera Touch', keywords: ['OPT/'] },
    { id: 'operacrypto', name: 'Opera Crypto', keywords: ['Opera Crypto', 'Crypto Browser'] },
    { id: 'operaneon', name: 'Opera Neon', keywords: ['Opera Neon'] },
    { id: 'operadev', name: 'Opera Developer', keywords: ['Opera Developer'] },
    { id: 'opera', name: 'Opera', keywords: ['Opera/', 'OPR/'] },
    {
        id: 'safaritech',
        name: 'Safari Technology Preview',
        keywords: ['Safari Technology Preview'],
    },
    { id: 'samsung', name: 'Samsung Internet', keywords: ['SamsungBrowser/'] },
    { id: 'silk', name: 'Amazon Silk', keywords: ['Silk/'] },
    { id: 'supermium', name: 'Supermium', keywords: ['Supermium/'] },
    { id: 'uc', name: 'UC Browser', keywords: ['UCBrowser/'], isLegacy: true },
    { id: 'waterfox', name: 'Waterfox', keywords: ['Waterfox/'] },
    { id: 'chrome', name: 'Chrome', keywords: ['Chrome/'] },
    { id: 'safari', name: 'Safari', keywords: ['Safari/'] },
];

// Browsers/engines that embed "Chrome/" or "Safari/" in their UA. When a more
// specific client from these sets also matches, it wins over the generic
// Chrome/Safari fallback. Hoisted to module scope so they aren't rebuilt on
// every parse. Safari additionally yields to Chrome and several consoles.
const CHROME_OVERRIDES = new Set([
    'edge',
    'edgebeta',
    'edgedev',
    'edgecanary',
    'brave',
    'opera',
    'operagx',
    'operadev',
    'operacrypto',
    'operaneon',
    'arc',
    'kindle',
    'vivaldi',
    'yandex',
    'samsung',
    'uc',
    'duckduckgo',
    'atlas',
    'supermium',
    'maxthon',
    'konqueror',
]);
const SAFARI_OVERRIDES = new Set([
    ...CHROME_OVERRIDES,
    'chrome',
    'ps4',
    'switch',
    'psvita',
    'safaritech',
    'midori',
    'camino',
]);

/**
 * Parses a User-Agent string to identify the client.
 *
 * @param {string} userAgent - The User-Agent string to parse.
 * @returns {object} { id, name, isLegacy } of the detected client, or null if unknown.
 */
function parseUserAgent(userAgent) {
    if (!userAgent) return null;
    if (clientCache.has(userAgent)) return clientCache.get(userAgent);

    let detectedClient = null;

    // Special case for Xbox (needs to distinguish between Xbox 360 and Xbox One)
    if (userAgent.includes('Xbox One')) {
        detectedClient = { id: 'xboxone', name: 'Xbox One', isLegacy: false };
    } else if (userAgent.includes('Xbox')) {
        detectedClient = { id: 'xbox360', name: 'Xbox 360', isLegacy: true };
    } else if (userAgent.includes('Nintendo 3DS')) {
        // New 3DS ("SKATER") units identify themselves via the 'NintendoBrowser'
        // token rather than always including the literal "New Nintendo 3DS"
        // string (see draw.ts), so a plain keyword match on "New Nintendo 3DS"
        // misses real New 3DS hardware and leaves it wrongly classified as the
        // legacy Old 3DS ("SPIDER").
        const isNewHardware =
            userAgent.includes('New Nintendo 3DS') || userAgent.includes('NintendoBrowser');
        detectedClient = isNewHardware
            ? { id: 'new3ds', name: 'New Nintendo 3DS', isLegacy: false }
            : { id: '3ds', name: 'Nintendo 3DS', isLegacy: true };
    } else if (
        userAgent.includes('Firefox/') &&
        (userAgent.includes('0a1') || userAgent.includes('0a2'))
    ) {
        detectedClient = { id: 'firefoxdev', name: 'Firefox Developer Edition', isLegacy: false };
    } else {
        // General keyword search
        for (const client of CLIENTS) {
            if (client.id === 'xboxone' || client.id === 'xbox360') continue; // Handled above
            if (client.id === 'new3ds' || client.id === '3ds') continue; // Handled above

            const matches = client.keywords.some((keyword) => userAgent.includes(keyword));
            if (matches) {
                // Chrome/Safari are substrings of many other browsers' UAs; if a
                // more specific client also matches, let it win instead.
                if (client.id === 'chrome' || client.id === 'safari') {
                    const overrides = client.id === 'chrome' ? CHROME_OVERRIDES : SAFARI_OVERRIDES;
                    const isOther = CLIENTS.some(
                        (c) => overrides.has(c.id) && c.keywords.some((k) => userAgent.includes(k))
                    );
                    if (isOther) continue;
                }

                detectedClient = { id: client.id, name: client.name, isLegacy: !!client.isLegacy };
                break;
            }
        }
    }

    clientCache.set(userAgent, detectedClient);
    return detectedClient;
}

/**
 * Returns true if the client is considered a legacy or low-resource device.
 *
 * @param {string} userAgent
 * @returns {boolean}
 */
function isLegacyClient(userAgent) {
    const client = parseUserAgent(userAgent);
    return !!(client && client.isLegacy);
}

module.exports = {
    parseUserAgent,
    isLegacyClient,
};
