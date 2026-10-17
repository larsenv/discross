'use strict';
const https = require('https');
const http = require('http');
const net = require('net');
const dns = require('dns').promises;
const dnsLookup = require('dns').lookup;
const sharp = require('sharp');
const { getTemplate } = require('./utils');
const { isLegacyClient } = require('./userAgentUtils');

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
        if (/^fe[89ab]/.test(lower) || lower.startsWith('fc') || lower.startsWith('fd'))
            return true; // link-local fe80::/10, unique-local fc00::/7
        // NAT64 (64:ff9b::/96) embeds an IPv4 destination the gateway will reach.
        if (lower.startsWith('64:ff9b:')) {
            const embedded = extractMappedIpv4(lower.replace(/^64:ff9b:(0:)*:?/, '::'));
            return embedded ? isPrivateIpv4(embedded) : true;
        }
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
    if (a === 192 && b === 0 && p[2] === 0) return true; // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
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

// Upstream bodies are buffered in memory for conversion, so cap their size and
// how long we wait for them; otherwise one URL pointing at a huge or endless
// response could exhaust memory or tie up sockets.
const MAX_UPSTREAM_BYTES = 25 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 20 * 1000;
// Decoded size matters as much as download size: a small file can expand to a
// huge bitmap. sharp's default limit is ~268 megapixels.
const MAX_INPUT_PIXELS = 64 * 1024 * 1024;

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

/**
 * Browsers that can show WebP say so in their image Accept header; the Wii,
 * 3DS, PSP and old desktop browsers never do. Those keep the small 256-colour
 * GIFs, while modern browsers get WebP sized for Discord's display limits
 * (550x350 inline, at 2x for high-DPI screens).
 */
function wantsModernImage(req) {
    const accept = String(req?.headers?.accept || '');
    return /image\/webp/i.test(accept) && !isLegacyClient(req?.headers?.['user-agent']);
}

const LEGACY_SIZE = { inline: 256, full: 1024 };
const MODERN_SIZE = { inline: { width: 1100, height: 700 }, full: { width: 2560, height: 2560 } };

exports.imageProxy = async function imageProxy(req, res, URL, fullSize = false) {
    const modern = wantsModernImage(req);
    const cacheKey = (fullSize ? URL + ':full' : URL) + (modern ? ':webp' : '');
    // Serve from in-memory cache if available
    if (imageCache.has(cacheKey)) {
        const cached = imageCache.get(cacheKey);
        const cachedBuffer = cached.buffer || cached;
        const contentType = cached.contentType || detectBufferMimeType(cachedBuffer);
        res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': cachedBuffer.length,
            'Cache-Control': CACHE_CONTROL,
            Vary: 'Accept, User-Agent',
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
        timeout: UPSTREAM_TIMEOUT_MS,
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
            const declaredLength = parseInt(proxyRes.headers['content-length'] || '0', 10);
            if (declaredLength > MAX_UPSTREAM_BYTES) {
                proxyRes.destroy();
                res.writeHead(200, {
                    'Content-Type': 'image/gif',
                    'Content-Length': EMPTY_GIF.length,
                });
                res.end(EMPTY_GIF);
                return;
            }
            const chunks = [];
            let receivedBytes = 0;
            proxyRes.on('data', (chunk) => {
                receivedBytes += chunk.length;
                if (receivedBytes > MAX_UPSTREAM_BYTES) {
                    proxyRes.destroy(new Error('Upstream image too large'));
                    return;
                }
                chunks.push(chunk);
            });
            proxyRes
                .on('end', async () => {
                    const buffer = Buffer.concat(chunks);
                    if (!buffer || buffer.length === 0) {
                        res.writeHead(200, {
                            'Content-Type': 'image/gif',
                            'Content-Length': EMPTY_GIF.length,
                        });
                        res.end(EMPTY_GIF);
                        return;
                    }
                    try {
                        const image = sharp(buffer, {
                            animated: true,
                            limitInputPixels: MAX_INPUT_PIXELS,
                        });
                        const bounds = modern
                            ? MODERN_SIZE[fullSize ? 'full' : 'inline']
                            : {
                                  width: LEGACY_SIZE[fullSize ? 'full' : 'inline'],
                                  height: LEGACY_SIZE[fullSize ? 'full' : 'inline'],
                              };
                        const resized = image.resize({
                            ...bounds,
                            fit: 'inside',
                            withoutEnlargement: true,
                        });
                        const processedBuffer = await (
                            modern
                                ? resized.webp({ quality: fullSize ? 90 : 82, effort: 4 })
                                : // GIF keeps transfers small for the Wii Internet Channel.
                                  resized.toFormat('gif', { colors: 256 })
                        )
                            .toBuffer()
                            .catch(() => {
                                console.warn('Could not convert image, sending original');
                                return buffer;
                            });
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
                            Vary: 'Accept, User-Agent',
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
                    if (res.headersSent) return;
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
        .on('timeout', function () {
            this.destroy(new Error('Upstream image request timed out'));
        })
        .on('error', (err) => {
            console.log('Image proxy request error:', err.message || err);
            if (res.headersSent) return;
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
