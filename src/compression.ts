'use strict';
/**
 * gzip / Brotli for text responses.
 *
 * Pages are HTML with a lot of inline styling, so they shrink to a fraction of
 * their size (a channel page from ~90 KB to ~10 KB). That matters most on the
 * slow links old consoles sit behind. Nothing in front of the app compresses,
 * so it is done here.
 */

const zlib = require('zlib');
const { isAncientClient } = require('../pages/userAgentUtils');

// Set DISABLE_COMPRESSION=true to send everything uncompressed, as before.
const enabled = process.env.DISABLE_COMPRESSION !== 'true';

const COMPRESSIBLE_TYPE =
    /^(text\/|application\/(javascript|json|manifest\+json|xml|xhtml\+xml)|image\/svg\+xml)/i;
// Responses built per request. JSON is left out: here it is only ever a short
// API answer ({"success":true}), which compression would make bigger.
const COMPRESSIBLE_RESPONSE_TYPE =
    /^(text\/|application\/(javascript|xml|xhtml\+xml)|image\/svg\+xml)/i;

// Below this, compressing on the main thread is quicker than the round trip
// to the thread pool; above it, compress off-thread so other requests keep
// being served meanwhile.
const SYNC_COMPRESS_MAX_BYTES = 16 * 1024;

// Pages are compressed on every request, so favour speed. Brotli 4 is about as
// fast as gzip 6 and noticeably smaller.
const DYNAMIC_BROTLI_QUALITY = 4;
const DYNAMIC_GZIP_LEVEL = 6;

function brotliOptions(quality, sizeHint) {
    const params = {
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
        [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
    };
    if (sizeHint) params[zlib.constants.BROTLI_PARAM_SIZE_HINT] = sizeHint;
    return { params };
}

/**
 * Whether a Content-Type is worth compressing. Images, fonts, video and
 * archives are already compressed.
 */
function isCompressibleType(type) {
    return COMPRESSIBLE_TYPE.test(String(type || ''));
}

/**
 * The encoding to answer this request with: 'br', 'gzip' or null.
 *
 * Only what the browser asks for in Accept-Encoding is ever used, so a client
 * that doesn't send the header (most pre-2000 browsers) is unaffected. Browsers
 * old enough to get the plain HTML 3.2 pages are left alone even if they ask:
 * that generation (Netscape 4, IE 4) advertised gzip and then mishandled it.
 */
function pickEncoding(req) {
    if (!enabled) return null;
    const header = req.headers['accept-encoding'];
    if (!header) return null;

    let br = false;
    let gzip = false;
    for (const part of String(header).split(',')) {
        const [name, ...params] = part.trim().toLowerCase().split(';');
        const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
        if (q && !(parseFloat(q.slice(2)) > 0)) continue;
        if (name === 'br') br = true;
        else if (name === 'gzip' || name === 'x-gzip') gzip = true;
    }
    if (!br && !gzip) return null;
    if (isAncientClient(req.headers['user-agent'])) return null;
    return br ? 'br' : 'gzip';
}

function addVary(existing, value) {
    const current = existing ? String(existing) : '';
    if (current.toLowerCase().includes(value.toLowerCase())) return current;
    return current ? `${current}, ${value}` : value;
}

/**
 * Compresses a whole buffer as well as it can be, for content that is
 * compressed once and then served many times (static files).
 *
 * @param {Buffer} buffer
 * @param {'br'|'gzip'} encoding
 * @returns {Promise<Buffer>}
 */
function compressForCache(buffer, encoding) {
    return new Promise((resolve, reject) => {
        const done = (err, out) => (err ? reject(err) : resolve(out));
        if (encoding === 'br') {
            zlib.brotliCompress(buffer, brotliOptions(11, buffer.length), done);
        } else {
            zlib.gzip(buffer, { level: 9 }, done);
        }
    });
}

/**
 * Makes a response compress itself when it turns out to be text the browser
 * accepts compressed. Handlers keep calling writeHead()/write()/end() as usual.
 *
 * A response is left alone when it already says how long it is or how it is
 * encoded (Content-Length / Content-Encoding / Content-Range): images, proxied
 * files and static assets that are served from a pre-compressed copy.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
function enableCompression(req, res) {
    if (!enabled) return;

    const realWriteHead = res.writeHead;
    const realWrite = res.write;
    const realEnd = res.end;

    let decided = false;
    let encoding = null; // set once the response is known to be compressed
    let stream = null; // only for bodies sent in pieces with write()

    // Looks at the status and headers once, just before they are sent.
    function decide(statusCode, headers) {
        decided = true;
        const header = (name) => {
            if (headers) {
                const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
                if (key !== undefined) return headers[key];
            }
            return res.getHeader(name);
        };
        const setHeader = (name, value) => {
            const key = headers
                ? Object.keys(headers).find((k) => k.toLowerCase() === name)
                : undefined;
            if (key !== undefined) headers[key] = value;
            else res.setHeader(name, value);
        };

        if (!COMPRESSIBLE_RESPONSE_TYPE.test(String(header('content-type') || ''))) return;
        // A cache between us and the browser must not hand a compressed copy
        // to a client that didn't ask for one.
        setHeader('vary', addVary(header('vary'), 'Accept-Encoding'));

        if (req.method === 'HEAD') return;
        // Redirects and "no content" answers carry no body worth compressing.
        if (statusCode < 200 || statusCode === 204 || (statusCode >= 300 && statusCode < 400)) {
            return;
        }
        if (header('content-encoding') || header('content-length') || header('content-range')) {
            return;
        }

        const chosen = pickEncoding(req);
        if (!chosen) return;
        encoding = chosen;
        setHeader('content-encoding', chosen);
    }

    res.writeHead = function (statusCode, ...args) {
        if (!decided) {
            try {
                const headers = args.find(
                    (arg) => arg && typeof arg === 'object' && !Array.isArray(arg)
                );
                // Headers given as a raw [name, value, ...] list can't be
                // amended safely; send those responses as they are.
                if (args.some(Array.isArray)) decided = true;
                else decide(statusCode, headers);
            } catch (err) {
                decided = true;
                encoding = null;
                console.error('Failed to set up response compression:', err);
            }
        }
        return realWriteHead.call(this, statusCode, ...args);
    };

    // A body sent without writeHead(): the headers go out with the first
    // write()/end(), so decide now.
    function decideFromSetHeaders() {
        if (decided || res.headersSent) return;
        try {
            decide(res.statusCode, null);
        } catch (err) {
            decided = true;
            encoding = null;
            console.error('Failed to set up response compression:', err);
        }
    }

    function startStream() {
        stream =
            encoding === 'br'
                ? zlib.createBrotliCompress(brotliOptions(DYNAMIC_BROTLI_QUALITY, 0))
                : zlib.createGzip({ level: DYNAMIC_GZIP_LEVEL });
        stream.on('data', (data) => {
            if (realWrite.call(res, data) === false) {
                stream.pause();
                res.once('drain', () => stream.resume());
            }
        });
        stream.on('end', () => realEnd.call(res));
        stream.on('error', (err) => res.destroy(err));
        // Whoever is piping into the response waits for 'drain' on it.
        stream.on('drain', () => res.emit('drain'));
    }

    res.write = function (chunk, enc, callback) {
        decideFromSetHeaders();
        if (!encoding) return realWrite.call(this, chunk, enc, callback);
        if (!stream) startStream();
        return stream.write(chunk, enc, callback);
    };

    res.end = function (chunk, enc, callback) {
        if (typeof chunk === 'function') {
            callback = chunk;
            chunk = undefined;
            enc = undefined;
        } else if (typeof enc === 'function') {
            callback = enc;
            enc = undefined;
        }
        decideFromSetHeaders();
        if (!encoding) return realEnd.call(this, chunk, enc, callback);

        if (stream) {
            if (callback) res.once('finish', callback);
            if (chunk === undefined || chunk === null) stream.end();
            else stream.end(chunk, enc);
            return this;
        }

        const body =
            chunk === undefined || chunk === null
                ? Buffer.alloc(0)
                : Buffer.isBuffer(chunk)
                  ? chunk
                  : chunk instanceof Uint8Array
                    ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
                    : Buffer.from(String(chunk), enc || 'utf8');

        const send = (compressed) => realEnd.call(res, compressed, callback);
        const options =
            encoding === 'br'
                ? brotliOptions(DYNAMIC_BROTLI_QUALITY, body.length)
                : { level: DYNAMIC_GZIP_LEVEL };
        try {
            if (body.length <= SYNC_COMPRESS_MAX_BYTES) {
                send(
                    encoding === 'br'
                        ? zlib.brotliCompressSync(body, options)
                        : zlib.gzipSync(body, options)
                );
            } else {
                const compress = encoding === 'br' ? zlib.brotliCompress : zlib.gzip;
                compress(body, options, (err, compressed) => {
                    // The headers already promise a compressed body, so there
                    // is nothing valid left to send if this fails.
                    if (err) res.destroy(err);
                    else send(compressed);
                });
            }
        } catch (err) {
            res.destroy(err);
        }
        return this;
    };
}

module.exports = {
    enableCompression,
    pickEncoding,
    isCompressibleType,
    compressForCache,
};
