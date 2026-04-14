'use strict';

/**
 * User-Agent Utility for parsing client device/browser information.
 */

const clientCache = new Map();

const CLIENTS = [
    { id: '3ds', name: 'Nintendo 3DS', keywords: ['Nintendo 3DS', 'New Nintendo 3DS'] },
    { id: 'arc', name: 'Arc', keywords: ['Arc/'] },
    { id: 'brave', name: 'Brave', keywords: ['Brave/'] },
    { id: 'dreamcast', name: 'Sega Dreamcast', keywords: ['Sega Dreamcast', 'Planetweb', 'DreamKey'] },
    { id: 'dsi', name: 'Nintendo DSi', keywords: ['Nintendo DSi'] },
    { id: 'ds', name: 'Nintendo DS', keywords: ['Nitro'] },
    { id: 'edge', name: 'Microsoft Edge', keywords: ['Edge/', 'Edg/'] },
    { id: 'firefox', name: 'Firefox', keywords: ['Firefox/'] },
    { id: 'ie', name: 'Internet Explorer', keywords: ['MSIE ', 'Trident/'] },
    { id: 'kindle', name: 'Kindle', keywords: ['Kindle/', 'Silk/'] },
    { id: 'opera', name: 'Opera', keywords: ['Opera/', 'OPR/'] },
    { id: 'ps2', name: 'PlayStation 2', keywords: ['Playstation2', 'PS2', 'EGBrowser'] },
    { id: 'ps3', name: 'PlayStation 3', keywords: ['PLAYSTATION 3'] },
    { id: 'ps4', name: 'PlayStation 4', keywords: ['PlayStation 4'] },
    { id: 'psp', name: 'PSP', keywords: ['PSP (PlayStation Portable)'] },
    { id: 'psvita', name: 'PlayStation Vita', keywords: ['PlayStation Vita'] },
    { id: 'saturn', name: 'Sega Saturn', keywords: ['Sega Saturn'] },
    { id: 'switch', name: 'Nintendo Switch', keywords: ['Nintendo Switch'] },
    { id: 'wiiu', name: 'Nintendo Wii U', keywords: ['Nintendo WiiU'] },
    { id: 'wii', name: 'Nintendo Wii', keywords: ['Nintendo Wii'] },
    { id: 'xbox360', name: 'Xbox 360', keywords: ['Xbox 360', 'Xbox'] },
    { id: 'xboxone', name: 'Xbox One', keywords: ['Xbox One'] },
    { id: 'chrome', name: 'Chrome', keywords: ['Chrome/'] },
    { id: 'safari', name: 'Safari', keywords: ['Safari/'] },
];

/**
 * Parses a User-Agent string to identify the client.
 *
 * @param {string} userAgent - The User-Agent string to parse.
 * @returns {object} { id, name } of the detected client, or null if unknown.
 */
function parseUserAgent(userAgent) {
    if (!userAgent) return null;
    if (clientCache.has(userAgent)) return clientCache.get(userAgent);

    let detectedClient = null;

    // Special case for Xbox (needs to distinguish between Xbox 360 and Xbox One)
    if (userAgent.includes('Xbox One')) {
        detectedClient = { id: 'xboxone', name: 'Xbox One' };
    } else if (userAgent.includes('Xbox')) {
        detectedClient = { id: 'xbox360', name: 'Xbox 360' };
    } else {
        // General keyword search
        for (const client of CLIENTS) {
            if (client.id === 'xboxone' || client.id === 'xbox360') continue; // Handled above

            const matches = client.keywords.some((keyword) => userAgent.includes(keyword));
            if (matches) {
                // Secondary checks for generic engines
                if (client.id === 'chrome') {
                    // Chrome is often in Edge, Brave, Opera, Arc, etc.
                    const isOther = CLIENTS.some(
                        (c) =>
                            ['edge', 'brave', 'opera', 'arc', 'kindle'].includes(c.id) &&
                            c.keywords.some((k) => userAgent.includes(k))
                    );
                    if (isOther) continue;
                }
                if (client.id === 'safari') {
                    // Safari is in Chrome, Edge, etc.
                    const isOther = CLIENTS.some(
                        (c) =>
                            ['chrome', 'edge', 'brave', 'opera', 'arc', 'kindle', 'ps4', 'switch', 'psvita'].includes(c.id) &&
                            c.keywords.some((k) => userAgent.includes(k))
                    );
                    if (isOther) continue;
                }

                detectedClient = { id: client.id, name: client.name };
                break;
            }
        }
    }

    clientCache.set(userAgent, detectedClient);
    return detectedClient;
}

module.exports = {
    parseUserAgent,
};
