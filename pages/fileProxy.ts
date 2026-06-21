'use strict';
const https = require('https');
const { getTemplate } = require('./utils');

exports.fileProxy = async function fileProxy(res, URL, req) {
    // Basically image proxy but without image-specific stuff.
    // Forwards Range headers so audio/video seeking works in <audio>/<video> elements.
    const reqHeaders = {};
    if (req && req.headers && req.headers['range']) {
        reqHeaders['Range'] = req.headers['range'];
    }

    https
        .get(URL, { headers: reqHeaders }, (proxyRes) => {
            const responseHeaders = {
                'Content-Type': proxyRes.headers['content-type'] || 'application/octet-stream',
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
                if ((err.message || err).includes('error reading from remote stream')) {
                    res.end(getTemplate('proxy-timeout-error', 'misc'));
                } else {
                    res.end(getTemplate('generic-error', 'misc'));
                }
            }
        });
};
