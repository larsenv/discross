const https = require('https');
const sharp = require('sharp');

exports.imageProxy = async function imageProxy(res, URL) {
    https.get(URL, (proxyRes) => {
        const chunks = [];
        proxyRes.on('data', (chunk) => {
            chunks.push(chunk);
        });
        proxyRes.on('end', async () => {
            const buffer = Buffer.concat(chunks);
            let gifbuffer = buffer
            try {
                if (buffer.length > 200000) { // If the buffer is way too big the server crashes. I don't know the exact threshold but it's around 200000
                    await sharp(buffer)
                        .metadata()
                        .then(async metadata => {
                            gifbuffer = await sharp(buffer)
                                .resize(Math.floor(metadata.width / 4), Math.floor(metadata.height / 4)) // Compress to make it smaller.
                                .toFormat('gif', { colors: 16 })                 // Hopefully this will be enough to avoid crashes.
                                .toBuffer()
                        })
                        .catch(err => {
                            // If conversion fails, just send original
                            console.log('Could not convert large image, sending original');
                            gifbuffer = buffer;
                        });
                } else {
                    await sharp(buffer)
                        .metadata()
                        .then(async metadata => {
                            if (metadata.format == "gif") {
                                gifbuffer = buffer
                            } else {
                                gifbuffer = await sharp(buffer)
                                    .toFormat('gif')
                                    .toBuffer();
                            }
                        })
                        .catch(err => {
                            // If conversion fails, just send original
                            console.log('Could not convert image format, sending original');
                            gifbuffer = buffer;
                        });
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
