const https = require('https');
const http = require('http');
const sharp = require('sharp');

// Smallest valid 1x1 transparent GIF, used as a fallback when an upstream image fails to load
const EMPTY_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// In-memory cache for converted GIF buffers.
// Bounded to MAX_CACHE_SIZE entries; oldest entry is evicted when full.
const MAX_CACHE_SIZE = 512;
const imageCache = new Map();

// Browser-side cache lifetime for proxied images (24 hours)
const CACHE_CONTROL = 'public, max-age=86400';

function cacheSet(key, value) {
    if (imageCache.size >= MAX_CACHE_SIZE) {
        // Delete the oldest (first-inserted) entry
        imageCache.delete(imageCache.keys().next().value);
    }
    imageCache.set(key, value);
}

exports.imageProxy = async function imageProxy(res, URL) {
    // Serve from in-memory cache if available
    if (imageCache.has(URL)) {
        const cached = imageCache.get(URL);
        res.writeHead(200, {
            'Content-Type': 'image/gif',
            'Content-Length': cached.length,
            'Cache-Control': CACHE_CONTROL,
        });
        res.end(cached);
        return;
    }

    // Choose the appropriate protocol handler
    const protocol = URL.startsWith('https:') ? https : http;
    
    protocol.get(URL, (proxyRes) => {
        // If the upstream server returned an error, return a 1x1 transparent GIF so the
        // browser renders nothing rather than showing a broken image or error text.
        if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300) {
            console.log(`Image proxy: upstream returned ${proxyRes.statusCode} for ${URL}`);
            // Drain the response to free the socket
            proxyRes.resume();
            res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': EMPTY_GIF.length });
            res.end(EMPTY_GIF);
            return;
        }
        const chunks = [];
        proxyRes.on('data', (chunk) => {
            chunks.push(chunk);
        });
        proxyRes.on('end', async () => {
            const buffer = Buffer.concat(chunks);
            let gifbuffer = buffer;
            try {
                // Resize options: cap all images at 256x256 to keep transfers small for Wii Internet Channel
                const resizeOptions = { width: 256, height: 256, fit: 'inside', withoutEnlargement: true };
                try {
                    gifbuffer = await sharp(buffer, { animated: true })
                        .resize(resizeOptions)
                        .toFormat('gif', { colors: 256 })
                        .toBuffer();
                } catch (err) {
                    // If conversion fails, just send original
                    console.log('Could not convert image, sending original');
                    gifbuffer = buffer;
                }
                cacheSet(URL, gifbuffer);
                res.writeHead(200, {
                    'Content-Type': 'image/gif',
                    'Content-Length': gifbuffer.length,
                    'Cache-Control': CACHE_CONTROL,
                });
                res.end(gifbuffer);
            } catch (error) {
                console.error('Error processing image:', error.message);
                // Send original buffer instead of error
                res.writeHead(200, {
                    'Content-Type': 'image/gif',
                    'Content-Length': buffer.length,
                });
                res.end(buffer);
            }
        }).on('error', (err) => {
            console.error('Error fetching image:', err);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('An error occurred. Please email admin@discross.net or contact us on our Discord server. Make sure to let us know where you had found the error');
        });
    })
}
