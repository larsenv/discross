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
    { id: 'wii', name: 'Nintendo Wii', keywords: ['Nintendo Wii'] },
    { id: 'switch', name: 'Nintendo Switch', keywords: ['Nintendo Switch'] },
    {
        id: 'ps2',
        name: 'PlayStation 2',
        keywords: ['Playstation2', 'PS2', 'EGBrowser'],
        isLegacy: true,
    },
    { id: 'ps3', name: 'PlayStation 3', keywords: ['PLAYSTATION 3'], isLegacy: true },
    { id: 'ps4', name: 'PlayStation 4', keywords: ['PlayStation 4'] },
    { id: 'psp', name: 'PSP', keywords: ['PSP (PlayStation Portable)'], isLegacy: true },
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
    { id: 'firefox', name: 'Firefox', keywords: ['Firefox/'] },
    { id: 'duckduckgo', name: 'DuckDuckGo', keywords: ['DuckDuckGo/'] },
    { id: 'icab', name: 'iCab', keywords: ['iCab/'] },
    { id: 'ie', name: 'Internet Explorer', keywords: ['MSIE ', 'Trident/'], isLegacy: true },
    { id: 'kindle', name: 'Kindle', keywords: ['Kindle/', 'Silk/'], isLegacy: true },
    { id: 'librewolf', name: 'LibreWolf', keywords: ['LibreWolf/'] },
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
]);
const SAFARI_OVERRIDES = new Set([
    ...CHROME_OVERRIDES,
    'chrome',
    'ps4',
    'switch',
    'psvita',
    'safaritech',
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
    } else if (
        userAgent.includes('Firefox/') &&
        (userAgent.includes('0a1') || userAgent.includes('0a2'))
    ) {
        detectedClient = { id: 'firefoxdev', name: 'Firefox Developer Edition', isLegacy: false };
    } else {
        // General keyword search
        for (const client of CLIENTS) {
            if (client.id === 'xboxone' || client.id === 'xbox360') continue; // Handled above

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
