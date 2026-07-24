'use strict';
const https = require('https');
const http = require('http');
const net = require('net');
const dns = require('dns').promises;
const dnsLookup = require('dns').lookup;
const sharp = require('sharp');
const { getTemplate } = require('./utils'); // Assuming utils.js exists and exports getTemplate

// --- SSRF protection ----------------------------------------------------------
// The /imageProxy/external/ endpoint fetches arbitrary client-supplied URLs.
// Without validation an attacker could point it at internal services or the
// cloud metadata endpoint (169.254.169.254) and read the response, since a
// non-image upstream body is passed back verbatim. We therefore reject any URL
// that isn't plain http/https to a publicly-routable address.

// Returns true if an IP literal is in a private, loopback, link-local, or
// otherwise non-public reserved range (covers the cloud metadata IP and
// IPv4-mapped IPv6 forms like ::ffff:127.0.0.1).
function isPrivateIp(ip) {
    const type = net.isIP(ip);
    if (type === 4) return isPrivateIpv4(ip);
    if (type === 6) {
        const lower = ip.toLowerCase();
        if (lower === '::1' || lower === '::') return true;
        if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd'))
            return true;
        // IPv4-mapped / -compatible addresses (::ffff:a.b.c.d or the hex form
        // ::ffff:7f00:1) resolve to a v4 destination — validate the embedded v4.
        const embedded = extractMappedIpv4(lower);
        if (embedded) return isPrivateIpv4(embedded);
        // An unparseable ::ffff: form is suspicious; refuse it.
        if (lower.includes('::ffff:') || lower.startsWith('::')) return true;
        return false;
    }
    return true; // not a valid IP literal → treat as unsafe
}

// Extract the embedded IPv4 from an IPv4-mapped/compatible IPv6 literal, handling
// both the dotted form (::ffff:127.0.0.1) and the hex form (::ffff:7f00:1).
function extractMappedIpv4(lower) {
    const dotted = lower.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (dotted) return dotted[1];
    const hex = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
        const hi = parseInt(hex[1], 16);
        const lo = parseInt(hex[2], 16);
        return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
    return null;
}

function isPrivateIpv4(ip) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127) return true; // 0/8, 10/8, loopback
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a >= 224) return true; // multicast / reserved
    return false;
}

// Resolve and validate a URL is safe to fetch. Returns true only for http(s)
// URLs whose host resolves entirely to public addresses.
async function isSafePublicUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

    const host = parsed.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
    if (net.isIP(host)) return !isPrivateIp(host);

    try {
        const records = await dns.lookup(host, { all: true });
        if (!records.length) return false;
        return records.every((r) => !isPrivateIp(r.address));
    } catch {
        return false;
    }
}

// Custom lookup used by the actual http(s) request. The isSafePublicUrl()
// pre-check and the real connection would otherwise resolve DNS separately,
// leaving a TOCTOU window where a rebinding attacker swaps a public answer for
// a private one. Validating here — on the exact address used to connect —
// closes that window: the socket can only be opened to a vetted public IP.
function safeLookup(hostname, options, callback) {
    dnsLookup(hostname, options, (err, address, family) => {
        if (err) return callback(err);
        const addresses = Array.isArray(address) ? address.map((a) => a.address) : [address];
        for (const addr of addresses) {
            if (isPrivateIp(addr)) {
                return callback(new Error(`Blocked non-public address: ${addr}`));
            }
        }
        callback(null, address, family);
    });
}

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

function detectBufferMimeType(buf) {
    if (!buf || buf.length < 4) return 'image/gif';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
        return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46)
        return 'image/webp';
    return 'image/gif';
}

exports.imageProxy = async function imageProxy(req, res, URL, fullSize = false) {
    const cacheKey = fullSize ? URL + ':full' : URL;
    // Serve from in-memory cache if available
    if (imageCache.has(cacheKey)) {
        const cached = imageCache.get(cacheKey);
        const cachedBuffer = cached.buffer || cached;
        const contentType = cached.contentType || detectBufferMimeType(cachedBuffer);
        res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': cachedBuffer.length,
            'Cache-Control': CACHE_CONTROL,
        });
        res.end(cachedBuffer);
        return;
    }

    // SSRF guard: refuse to fetch internal/non-public destinations.
    if (!(await isSafePublicUrl(URL))) {
        console.warn(`Image proxy: blocked non-public URL ${URL}`);
        res.writeHead(400, { 'Content-Type': 'image/gif', 'Content-Length': EMPTY_GIF.length });
        res.end(EMPTY_GIF);
        return;
    }

    // Choose the appropriate protocol handler
    const protocol = URL.startsWith('https:') ? https : http;

    const options = {
        lookup: safeLookup,
        headers: {
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        },
    };

    protocol
        .get(URL, options, (proxyRes) => {
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
                        let contentType = 'image/gif';
                        if (processedBuffer === buffer) {
                            contentType = detectBufferMimeType(buffer);
                        } else {
                            contentType = detectBufferMimeType(processedBuffer);
                        }

                        cacheSet(cacheKey, { buffer: processedBuffer, contentType });
                        res.writeHead(200, {
                            'Content-Type': contentType,
                            'Content-Length': processedBuffer.length,
                            'Cache-Control': CACHE_CONTROL,
                        });
                        res.end(processedBuffer);
                    } catch (error) {
                        console.error('Error processing image:', error);
                        const fallbackType = detectBufferMimeType(buffer);
                        res.writeHead(200, {
                            'Content-Type': fallbackType,
                            'Content-Length': buffer.length,
                        });
                        res.end(buffer);
                    }
                })
                .on('error', (err) => {
                    console.log('Error fetching image:', err.message || err);
                    res.writeHead(500, { 'Content-Type': 'text/html' });
                    if (
                        (err.message || err).toString().includes('error reading from remote stream')
                    ) {
                        res.end(getTemplate('proxy-timeout-error', 'misc'));
                    } else {
                        res.end(getTemplate('generic-error', 'misc'));
                    }
                });
        })
        .on('error', (err) => {
            console.log('Image proxy request error:', err.message || err);
            res.writeHead(500, { 'Content-Type': 'text/html' });
            if ((err.message || err).toString().includes('error reading from remote stream')) {
                res.end(getTemplate('proxy-timeout-error', 'misc'));
            } else {
                res.end(getTemplate('generic-error', 'misc'));
            }
        });
};

exports.isSafePublicUrl = isSafePublicUrl;
exports.safeLookup = safeLookup;
