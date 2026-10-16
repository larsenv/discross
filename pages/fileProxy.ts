'use strict';
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { getTemplate } = require('./utils');
const { isSafePublicUrl, safeLookup } = require('./imageProxy');

// Proxied files are user uploads served from this origin. Anything a browser
// would execute (HTML, SVG, XML, scripts) is downgraded to plain text, and the
// sandbox CSP stops it running even if a browser sniffs it anyway.
const ACTIVE_CONTENT_TYPE =
    /^(text\/html|application\/xhtml|image\/svg|text\/xml|application\/xml|[a-z]+\/(x-)?(java|ecma)script)/i;

function safeContentType(upstreamType) {
    const type = upstreamType || 'application/octet-stream';
    return ACTIVE_CONTENT_TYPE.test(type.trim()) ? 'text/plain; charset=utf-8' : type;
}

exports.fileProxy = async function fileProxy(res, urlStr, req, redirects = 0) {
    if (redirects > 5) {
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end(getTemplate('generic-error', 'misc'));
        }
        return;
    }

    if (!(await isSafePublicUrl(urlStr))) {
        if (!res.headersSent) {
            res.writeHead(403, { 'Content-Type': 'text/html' });
            res.end(getTemplate('no-permission', 'misc'));
        }
        return;
    }

    // Basically image proxy but without image-specific stuff.
    // Forwards Range headers so audio/video seeking works in <audio>/<video> elements.
    const reqHeaders = {};
    if (req && req.headers && req.headers['range']) {
        reqHeaders['Range'] = req.headers['range'];
    }
    reqHeaders['User-Agent'] = 'Discross/1.0';

    const client = urlStr.startsWith('http:') ? http : https;
    client
        .get(urlStr, { headers: reqHeaders, lookup: safeLookup }, (proxyRes) => {
            if (
                [301, 302, 303, 307, 308].includes(proxyRes.statusCode) &&
                proxyRes.headers['location']
            ) {
                proxyRes.resume();
                try {
                    const nextUrl = new URL(proxyRes.headers['location'], urlStr).href;
                    return exports.fileProxy(res, nextUrl, req, redirects + 1);
                } catch (e) {
                    // fall through if URL is invalid
                }
            }

            const responseHeaders = {
                'Content-Type': safeContentType(proxyRes.headers['content-type']),
                'Content-Security-Policy': "default-src 'none'; sandbox",
            };
            // Forward headers that matter for streaming / seeking
            if (proxyRes.headers['content-length'])
                responseHeaders['Content-Length'] = proxyRes.headers['content-length'];
            if (proxyRes.headers['content-disposition'])
                responseHeaders['Content-Disposition'] = proxyRes.headers['content-disposition'];
            if (proxyRes.headers['content-range'])
                responseHeaders['Content-Range'] = proxyRes.headers['content-range'];
            if (proxyRes.headers['accept-ranges'])
                responseHeaders['Accept-Ranges'] = proxyRes.headers['accept-ranges'];

            res.writeHead(proxyRes.statusCode, responseHeaders);
            proxyRes.pipe(res);
        })
        .on('error', (err) => {
            console.error('Error fetching file:', err);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/html' });
                if ((err.message || err).toString().includes('error reading from remote stream')) {
                    res.end(getTemplate('proxy-timeout-error', 'misc'));
                } else {
                    res.end(getTemplate('generic-error', 'misc'));
                }
            }
        });
};
