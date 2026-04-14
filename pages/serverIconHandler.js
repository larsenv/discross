'use strict';
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const sanitizer = require('path-sanitizer').default;
const { generatePlaceholderIconAsGif } = require('./iconGenerator.js');

// Note: Using built-in fetch API (Node.js 18+)

/**
 * Handle server icon requests with fallback to Discord CDN and placeholder generation
 * @param {object} bot - Discord bot client
 * @param {object} res - HTTP response object
 * @param {string} serverID - Server ID
 * @param {string} iconHash - Icon hash (without extension)
 * @param {string} theme - Theme: 'dark', 'light', or 'amoled'
 */
async function handleServerIcon(bot, res, serverID, iconHash, theme = 'dark') {
    const iconDir = path.resolve('pages/static/ico/server', sanitizer(serverID));
    const iconPath = path.resolve(iconDir, sanitizer(`${iconHash}.gif`));

    // Check if icon exists locally
    if (fs.existsSync(iconPath)) {
        // Serve the existing icon
        try {
            const iconData = await fs.promises.readFile(iconPath);
            res.writeHead(200, {
                'Content-Type': 'image/gif',
                'Cache-Control': 'public, max-age=86400',
            });
            res.end(iconData);
            return;
        } catch (err) {
            console.error('Error reading icon file:', err);
        }
    }

    // Icon doesn't exist locally, try to fetch from Discord CDN
    try {
        // Try animated GIF first, then fall back to static PNG
        const gifUrl = `https://cdn.discordapp.com/icons/${serverID}/a_${iconHash}.gif?size=128`;
        const pngUrl = `https://cdn.discordapp.com/icons/${serverID}/${iconHash}.png?size=128`;
        const gifResponse = await fetch(gifUrl);
        const [iconUrl, response] = gifResponse.ok
            ? [gifUrl, gifResponse]
            : [pngUrl, await fetch(pngUrl)];

        if (response.ok) {
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            // Create directory if it doesn't exist
            await fs.promises.mkdir(iconDir, { recursive: true });

            // Convert to GIF and save
            const gifBuffer = iconUrl.endsWith('.gif')
                ? buffer
                : await sharp(buffer).gif().toBuffer();

            await fs.promises.writeFile(iconPath, gifBuffer);

            // Serve the icon
            res.writeHead(200, {
                'Content-Type': 'image/gif',
                'Cache-Control': 'public, max-age=86400',
            });
            res.end(gifBuffer);
            return;
        }
    } catch (err) {
        console.error('Error fetching icon from Discord CDN:', err);
    }

    // Fallback: generate placeholder icon
    try {
        // Get server name from bot client (if available)
        const serverName = bot?.client?.guilds?.cache?.get(serverID)?.name ?? 'Server';

        const placeholderBuffer = await generatePlaceholderIconAsGif(serverName, theme);

        // Save placeholder to cache
        await fs.promises.mkdir(iconDir, { recursive: true });
        await fs.promises.writeFile(iconPath, placeholderBuffer);

        // Serve the placeholder
        res.writeHead(200, {
            'Content-Type': 'image/gif',
            'Cache-Control': 'public, max-age=86400',
        });
        res.end(placeholderBuffer);
    } catch (err) {
        console.error('Error generating placeholder icon:', err);

        // Last resort: return 404
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Icon not found');
    }
}

module.exports = {
    handleServerIcon,
};
