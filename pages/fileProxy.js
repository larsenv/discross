const https = require('https')

exports.fileProxy = async function fileProxy(res, URL) { // Basically image proxy but without image-specific stuff
    https.get(URL, (proxyRes) => {
        const chunks = [];
        proxyRes.on('data', (chunk) => {
            chunks.push(chunk);
        });
        proxyRes.on('end', async () => {
            const buffer = Buffer.concat(chunks);
            res.writeHead(proxyRes.statusCode, { "Content-Type": 'application/octet-stream', 'Content-Length': buffer.length })
            res.end(buffer)
        })

    }).on('error', (err) => {
        console.error('Error fetching file:', err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('An error occurred. Please email admin@discross.net or contact us on our Discord server. Make sure to let us know where you had found the error');
    });
}