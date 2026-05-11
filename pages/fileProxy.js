'use strict';
const https = require('https');
const { getTemplate } = require('./utils.js');

exports.fileProxy = async function fileProxy(res, URL) {
    // Basically image proxy but without image-specific stuff
    https
        .get(URL, (proxyRes) => {
            const chunks = [];
            proxyRes.on('data', (chunk) => {
                chunks.push(chunk);
            });
            proxyRes.on('end', () => {
                const buffer = Buffer.concat(chunks);
                res.writeHead(proxyRes.statusCode, {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': buffer.length,
                });
                res.end(buffer);
            });
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
