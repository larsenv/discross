const https = require('https');
const http = require('http');
const sharp = require('sharp');

// Smallest valid 1x1 transparent GIF, used as a fallback when an upstream image fails to load
const EMPTY_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

exports.imageProxy = async function imageProxy(res, URL) {
    // Choose the appropriate protocol handler
    const protocol = URL.startsWith('https:') ? https : http;

    const requestOptions = {
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Discross/1.0; +https://discross.net)',
            'Accept': 'image/*,*/*;q=0.8',
        }
    };

    protocol.get(URL, requestOptions, (proxyRes) => {
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
            let gifbuffer = buffer
            try {
                // Resize options: cap all images at 256x256 to keep transfers small for Wii Internet Channel
                const resizeOptions = { width: 256, height: 256, fit: 'inside', withoutEnlargement: true };
                if (buffer.length > 200000) { // If the buffer is way too big the server crashes. I don't know the exact threshold but it's around 200000
                    try {
                        gifbuffer = await sharp(buffer, { animated: true })
                            .resize(resizeOptions)
                            .toFormat('gif', { colors: 256 })                 // Hopefully this will be enough to avoid crashes.
                            .toBuffer();
                    } catch (err) {
                        // If conversion fails, just send original
                        console.log('Could not convert large image, sending original');
                        gifbuffer = buffer;
                    }
                } else {
                    try {
                        gifbuffer = await sharp(buffer, { animated: true })
                            .resize(resizeOptions)
                            .toFormat('gif', { colors: 256 })
                            .toBuffer();
                    } catch (err) {
                        // If conversion fails, just send original
                        console.log('Could not convert image format, sending original');
                        gifbuffer = buffer;
                    }
                }
                res.writeHead(200, {
                    'Content-Type': 'image/gif',
                    'Content-Length': gifbuffer.length,
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
