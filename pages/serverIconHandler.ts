'use strict';
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { generatePlaceholderIconAsGif } = require('./iconGenerator');
const { getTemplate, isValidSnowflake } = require('./utils');

// Note: Using built-in fetch API (Node.js 18+)

// Discord icon hashes are hex, with an "a_" prefix for animated ones. The
// handler is reachable without logging in, so both path parts are checked
// before they are used in a file path or a CDN URL.
const ICON_HASH_PATTERN = /^(a_)?[a-f0-9]{1,64}$/i;

// Placeholders are generated per request (the server name can change) and kept
// only in memory. Writing them to disk let anyone fill the disk with one file
// per made-up /ico/server/<id>/<hash>.gif path.
const PLACEHOLDER_CACHE_MAX = 500;
const placeholderCache = new Map();

function cachePlaceholder(key, buffer) {
    if (placeholderCache.size >= PLACEHOLDER_CACHE_MAX) {
        placeholderCache.delete(placeholderCache.keys().next().value);
    }
    placeholderCache.set(key, buffer);
}

function serveGif(res, buffer) {
    res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Cache-Control': 'public, max-age=86400',
    });
    res.end(buffer);
}

function serveNotFound(res) {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end(getTemplate('icon-not-found', 'misc'));
}

/**
 * Handle server icon requests with fallback to Discord CDN and placeholder generation
 * @param {object} bot - Discord bot client
 * @param {object} res - HTTP response object
 * @param {string} serverID - Server ID
 * @param {string} iconHash - Icon hash (without extension)
 * @param {string} theme - Theme: 'dark', 'light', or 'amoled'
 */
async function handleServerIcon(bot, res, serverID, iconHash, theme = 'dark') {
    if (!isValidSnowflake(serverID) || !ICON_HASH_PATTERN.test(iconHash || '')) {
        serveNotFound(res);
        return;
    }

    // Only servers the bot is actually in get an icon. Anything else would be
    // an outbound CDN request and a cached file for a guild that never
    // appears in anyone's server list.
    const guild = bot?.client?.guilds?.cache?.get(serverID);
    if (!guild) {
        serveNotFound(res);
        return;
    }

    const iconDir = path.resolve('pages/static/ico/server', serverID);
    const iconPath = path.resolve(iconDir, `${iconHash}.gif`);

    // Check if icon exists locally
    if (fs.existsSync(iconPath)) {
        // Serve the existing icon
        try {
            serveGif(res, await fs.promises.readFile(iconPath));
            return;
        } catch (err) {
            console.error('Error reading icon file:', err);
        }
    }

    // Icon doesn't exist locally, try to fetch from Discord CDN. Only the hash
    // Discord reports for this guild is fetched and cached; a stale or made-up
    // hash falls through to the placeholder.
    if (guild.icon && guild.icon.replace(/^a_/, '') === iconHash.replace(/^a_/, '')) {
        try {
            const isAnimated = guild.icon.startsWith('a_');
            const iconUrl = `https://cdn.discordapp.com/icons/${serverID}/${guild.icon}.${isAnimated ? 'gif' : 'png'}?size=128`;
            const response = await fetch(iconUrl);

            if (response.ok) {
                const buffer = Buffer.from(await response.arrayBuffer());

                // Create directory if it doesn't exist
                await fs.promises.mkdir(iconDir, { recursive: true });

                // Convert to GIF and save
                const gifBuffer = isAnimated ? buffer : await sharp(buffer).gif().toBuffer();

                await fs.promises.writeFile(iconPath, gifBuffer);

                serveGif(res, gifBuffer);
                return;
            }
        } catch (err) {
            console.error('Error fetching icon from Discord CDN:', err);
        }
    }

    // Fallback: generate placeholder icon (in memory only)
    try {
        const serverName = guild.name ?? 'Server';
        const cacheKey = `${serverID}:${theme}:${serverName}`;
        let placeholderBuffer = placeholderCache.get(cacheKey);
        if (!placeholderBuffer) {
            placeholderBuffer = await generatePlaceholderIconAsGif(serverName, theme);
            cachePlaceholder(cacheKey, placeholderBuffer);
        }
        serveGif(res, placeholderBuffer);
    } catch (err) {
        console.error('Error generating placeholder icon:', err);

        // Last resort: return 404
        serveNotFound(res);
    }
}

module.exports = {
    handleServerIcon,
};
