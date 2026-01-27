const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const sanitizer = require('path-sanitizer');
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
      res.writeHead(200, { 'Content-Type': 'image/gif' });
      res.write(iconData);
      res.end();
      return;
    } catch (err) {
      console.error('Error reading icon file:', err);
    }
  }
  
  // Icon doesn't exist locally, try to fetch from Discord CDN
  try {
    // Try animated GIF first
    let iconUrl = `https://cdn.discordapp.com/icons/${serverID}/a_${iconHash}.gif?size=128`;
    let response = await fetch(iconUrl);
    
    if (!response.ok) {
      // Try static PNG
      iconUrl = `https://cdn.discordapp.com/icons/${serverID}/${iconHash}.png?size=128`;
      response = await fetch(iconUrl);
    }
    
    if (response.ok) {
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      
      // Create directory if it doesn't exist
      await fs.promises.mkdir(iconDir, { recursive: true });
      
      // Convert to GIF and save
      let gifBuffer;
      if (iconUrl.endsWith('.gif')) {
        gifBuffer = buffer;
      } else {
        gifBuffer = await sharp(buffer).gif().toBuffer();
      }
      
      await fs.promises.writeFile(iconPath, gifBuffer);
      
      // Serve the icon
      res.writeHead(200, { 'Content-Type': 'image/gif' });
      res.write(gifBuffer);
      res.end();
      return;
    }
  } catch (err) {
    console.error('Error fetching icon from Discord CDN:', err);
  }
  
  // Fallback: generate placeholder icon
  try {
    // Get server name from bot client (if available)
    let serverName = 'Server';
    if (bot && bot.client && bot.client.guilds && bot.client.guilds.cache) {
      const server = bot.client.guilds.cache.get(serverID);
      if (server && server.name) {
        serverName = server.name;
      }
    }
    
    const placeholderBuffer = await generatePlaceholderIconAsGif(serverName, theme);
    
    // Save placeholder to cache
    await fs.promises.mkdir(iconDir, { recursive: true });
    await fs.promises.writeFile(iconPath, placeholderBuffer);
    
    // Serve the placeholder
    res.writeHead(200, { 'Content-Type': 'image/gif' });
    res.write(placeholderBuffer);
    res.end();
  } catch (err) {
    console.error('Error generating placeholder icon:', err);
    
    // Last resort: return 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Icon not found');
  }
}

module.exports = {
  handleServerIcon
};
