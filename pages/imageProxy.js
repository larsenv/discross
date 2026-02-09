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
                const metadata = await sharp(buffer).metadata();
                
                // Check if it's APNG - sharp doesn't handle animated PNGs well
                // If format is PNG and we're getting errors, just return the PNG as-is
                if (metadata.format === 'png') {
                    // For PNG (including APNG), just convert first frame to GIF
                    // This works for stickers even if animation is lost
                    gifbuffer = await sharp(buffer)
                        .toFormat('gif', { colors: 256 })
                        .toBuffer();
                } else if (buffer.length > 200000) { 
                    // If the buffer is way too big the server crashes
                    gifbuffer = await sharp(buffer)
                        .resize(Math.floor(metadata.width / 4), Math.floor(metadata.height / 4))
                        .toFormat('gif', { colors: 16 })
                        .toBuffer()
                } else {
                    if (metadata.format == "gif") {
                        gifbuffer = buffer
                    } else {
                        gifbuffer = await sharp(buffer)
                            .toFormat('gif')
                            .toBuffer();
                    }
                }
                
                res.writeHead(200, {
                    'Content-Type': 'image/gif',
                    'Content-Length': gifbuffer.length,
                });
                res.end(gifbuffer);
            } catch (error) {
                console.error('Error converting image to GIF:', error.message);
                // On error, try to send original buffer or a fallback
                try {
                    res.writeHead(200, {
                        'Content-Type': 'image/gif',
                        'Content-Length': buffer.length,
                    });
                    res.end(buffer);
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Error converting image');
                }
            }
        }).on('error', (err) => {
            console.error('Error fetching image:', err);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Error fetching image');
        });
    })
}
