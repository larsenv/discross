const fs = require('fs');
const path = require('path');
const https = require('https');
const sharp = require('sharp');
const AsyncLock = require('async-lock');

// Cache directory path
const CACHE_DIR = path.join(__dirname, 'static', 'emoji_cache');

// Lock to prevent race conditions when downloading the same emoji
const lock = new AsyncLock();

/**
 * Ensure the cache directory exists
 */
function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * Get the cache file path for an emoji
 * @param {string} emojiId - The Discord emoji ID
 * @returns {string} The full path to the cached emoji file
 */
function getCachePath(emojiId) {
  ensureCacheDir();
  return path.join(CACHE_DIR, `${emojiId}.gif`);
}

/**
 * Check if an emoji exists in cache
 * @param {string} emojiId - The Discord emoji ID
 * @param {boolean} isAnimated - Whether the emoji is animated (not used since we always cache as GIF)
 * @returns {boolean} True if the emoji is cached, false otherwise
 */
function checkCache(emojiId, isAnimated) {
  const cachePath = getCachePath(emojiId);
  return fs.existsSync(cachePath);
}

/**
 * Download and cache an emoji from Discord CDN
 * @param {string} emojiId - The Discord emoji ID
 * @param {boolean} isAnimated - Whether the emoji is animated
 * @returns {Promise<Buffer>} The emoji buffer
 */
async function cacheEmoji(emojiId, isAnimated) {
  // Construct the Discord CDN URL
  const extension = isAnimated ? 'gif' : 'png';
  const emojiUrl = `https://cdn.discordapp.com/emojis/${emojiId}.${extension}`;
  
  return new Promise((resolve, reject) => {
    https.get(emojiUrl, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', (chunk) => {
        chunks.push(chunk);
      });
      proxyRes.on('end', async () => {
        try {
          const buffer = Buffer.concat(chunks);
          let gifBuffer = buffer;
          
          // Convert to GIF and optimize if necessary
          if (buffer.length > 200000) {
            // Large emoji - compress it
            const metadata = await sharp(buffer).metadata();
            gifBuffer = await sharp(buffer)
              .resize(Math.floor(metadata.width / 4), Math.floor(metadata.height / 4))
              .toFormat('gif', { colors: 16 })
              .toBuffer();
          } else {
            // Convert to GIF if not already
            const metadata = await sharp(buffer).metadata();
            if (metadata.format !== "gif") {
              gifBuffer = await sharp(buffer)
                .toFormat('gif')
                .toBuffer();
            }
          }
          
          // Save to cache
          const cachePath = getCachePath(emojiId);
          fs.writeFileSync(cachePath, gifBuffer);
          
          resolve(gifBuffer);
        } catch (error) {
          reject(new Error(`Error converting emoji to GIF: ${error.message}`));
        }
      }).on('error', (err) => {
        reject(new Error(`Error fetching emoji: ${err.message}`));
      });
    }).on('error', (err) => {
      reject(new Error(`Error connecting to Discord CDN: ${err.message}`));
    });
  });
}

/**
 * Get emoji from cache or download if not cached
 * @param {string} emojiId - The Discord emoji ID
 * @param {boolean} isAnimated - Whether the emoji is animated
 * @returns {Promise<Buffer>} The emoji buffer
 */
async function getEmoji(emojiId, isAnimated) {
  // Use lock to prevent race conditions
  return lock.acquire(emojiId, async () => {
    // Check if already cached
    if (checkCache(emojiId, isAnimated)) {
      const cachePath = getCachePath(emojiId);
      return fs.readFileSync(cachePath);
    }
    
    // Not cached - download and cache it
    return await cacheEmoji(emojiId, isAnimated);
  });
}

/**
 * Serve emoji directly to HTTP response
 * @param {object} res - The HTTP response object
 * @param {string} emojiId - The Discord emoji ID
 * @param {boolean} isAnimated - Whether the emoji is animated
 */
async function serveEmoji(res, emojiId, isAnimated) {
  try {
    const emojiBuffer = await getEmoji(emojiId, isAnimated);
    
    // Set cache headers - cache for 1 year
    res.writeHead(200, {
      'Content-Type': 'image/gif',
      'Content-Length': emojiBuffer.length,
      'Cache-Control': 'public, max-age=31536000, immutable'
    });
    res.end(emojiBuffer);
  } catch (error) {
    console.error('Error serving emoji:', error.message);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Error serving emoji. Please email admin@discross.net or contact us on our Discord server. Make sure to let us know where you had found the error');
  }
}

module.exports = {
  checkCache,
  cacheEmoji,
  getEmoji,
  serveEmoji
};
