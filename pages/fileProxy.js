'use strict';
const https = require('https');
const { getTemplate } = require('./utils.js');

exports.fileProxy = async function fileProxy(res, URL) {
    // Basically image proxy but without image-specific stuff
    https
        .get(URL, (proxyRes) => {
            // Forward headers and status code
            res.writeHead(proxyRes.statusCode, {
                'Content-Type': proxyRes.headers['content-type'] || 'application/octet-stream',
                'Content-Length': proxyRes.headers['content-length'],
                'Content-Disposition': proxyRes.headers['content-disposition'],
            });

            // Pipe data directly to response
            proxyRes.pipe(res);
        })
        .on('error', (err) => {
            console.error('Error fetching file:', err);
            res.writeHead(500, { 'Content-Type': 'text/html' });
            if ((err.message || err).includes('error reading from remote stream')) {
                res.end(getTemplate('proxy-timeout-error', 'misc'));
            } else {
                res.end(getTemplate('generic-error', 'misc'));
            }
        });
};
