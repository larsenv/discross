'use strict';
const https = require('https');
const http = require('http');
const sharp = require('sharp');
const { getTemplate } = require('./utils.js'); // Assuming utils.js exists and exports getTemplate

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

exports.imageProxy = async function imageProxy(res, URL, fullSize = false) {
    const cacheKey = fullSize ? URL + ':full' : URL;
    // Serve from in-memory cache if available
    if (imageCache.has(cacheKey)) {
        const cached = imageCache.get(cacheKey);
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

    protocol
        .get(URL, (proxyRes) => {
            // If the upstream server returned an error, return a 1x1 transparent GIF so the
            // browser renders nothing rather than showing a broken image or error text.
            if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300) {
                console.log(`Image proxy: upstream returned ${proxyRes.statusCode} for ${URL}`);
                // Drain the response to free the socket
                proxyRes.resume();
                res.writeHead(200, {
                    'Content-Type': 'image/gif',
                    'Content-Length': EMPTY_GIF.length,
                });
                res.end(EMPTY_GIF);
                return;
            }
            const chunks = [];
            proxyRes.on('data', (chunk) => {
                chunks.push(chunk);
            });
            proxyRes
                .on('end', async () => {
                    const buffer = Buffer.concat(chunks);
                    try {
                        let processedBuffer;
                        if (fullSize) {
                            // Still convert to GIF for compatibility, but don't resize down to 256
                            // We might still want to cap it at a reasonable "full" size for legacy browsers, e.g. 1024
                            processedBuffer = await sharp(buffer, { animated: true })
                                .resize({
                                    width: 1024,
                                    height: 1024,
                                    fit: 'inside',
                                    withoutEnlargement: true,
                                })
                                .toFormat('gif', { colors: 256 })
                                .toBuffer()
                                .catch(() => {
                                    console.warn(
                                        'Could not convert full-size image, sending original'
                                    );
                                    return buffer;
                                });
                        } else {
                            // Resize options: cap all images at 256x256 to keep transfers small for Wii Internet Channel
                            const resizeOptions = {
                                width: 256,
                                height: 256,
                                fit: 'inside',
                                withoutEnlargement: true,
                            };
                            processedBuffer = await sharp(buffer, { animated: true })
                                .resize(resizeOptions)
                                .toFormat('gif', { colors: 256 })
                                .toBuffer()
                                .catch(() => {
                                    console.warn('Could not convert image, sending original');
                                    return buffer;
                                });
                        }
                        cacheSet(cacheKey, processedBuffer);
                        res.writeHead(200, {
                            'Content-Type': 'image/gif',
                            'Content-Length': processedBuffer.length,
                            'Cache-Control': CACHE_CONTROL,
                        });
                        res.end(processedBuffer);
                    } catch (error) {
                        console.error('Error processing image:', error);
                        // Send original buffer instead of error
                        res.writeHead(200, {
                            'Content-Type': 'image/gif',
                            'Content-Length': buffer.length,
                        });
                        res.end(buffer);
                    }
                })
                .on('error', (err) => {
                    console.log('Error fetching image:', err.message || err);
                    res.writeHead(500, { 'Content-Type': 'text/html' });
                    if ((err.message || err).includes('error reading from remote stream')) {
                        res.end(getTemplate('proxy-timeout-error', 'misc'));
                    } else {
                        res.end(getTemplate('generic-error', 'misc'));
                    }
                });
        })
        .on('error', (err) => {
            console.log('Image proxy request error:', err.message || err);
            res.writeHead(500, { 'Content-Type': 'text/html' });
            if ((err.message || err).includes('error reading from remote stream')) {
                res.end(getTemplate('proxy-timeout-error', 'misc'));
            } else {
                res.end(getTemplate('generic-error', 'misc'));
            }
        });
};
