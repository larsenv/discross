'use strict';
const discord = require('discord');
const sharp = require('sharp');
const auth = require('../src/authentication');
const { convertEmoji } = require('./emojiConvert');
const { getOrCreateWebhook } = require('./webhookCache');
const {
    resolveMentions,
    resolveNameMentions,
    buildAllowedMentions,
    canMentionEveryoneIn,
    getTemplate,
    renderTemplate,
    render,
} = require('./utils');

function decodeBmpToRgba(bmpBuf) {
    if (bmpBuf.length < 54 || bmpBuf[0] !== 0x42 || bmpBuf[1] !== 0x4d) {
        throw new Error('Not a valid BMP file header');
    }
    const offset = bmpBuf.readUInt32LE(10);
    const width = bmpBuf.readInt32LE(18);
    const heightRaw = bmpBuf.readInt32LE(22);
    const height = Math.abs(heightRaw);
    const bpp = bmpBuf.readUInt16LE(28);

    if (bpp !== 24 && bpp !== 32) {
        throw new Error('Unsupported BMP bpp: ' + bpp);
    }

    const bytesPerPixel = bpp / 8;
    const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
    const rgbaBuf = Buffer.alloc(width * height * 4);
    const isTopDown = heightRaw < 0;

    for (let y = 0; y < height; y++) {
        const srcY = isTopDown ? y : height - 1 - y;
        const rowStart = offset + srcY * rowSize;
        const dstRowStart = y * width * 4;

        for (let x = 0; x < width; x++) {
            const srcIdx = rowStart + x * bytesPerPixel;
            const dstIdx = dstRowStart + x * 4;

            if (srcIdx + 2 < bmpBuf.length) {
                rgbaBuf[dstIdx] = bmpBuf[srcIdx + 2]; // R
                rgbaBuf[dstIdx + 1] = bmpBuf[srcIdx + 1]; // G
                rgbaBuf[dstIdx + 2] = bmpBuf[srcIdx]; // B
                rgbaBuf[dstIdx + 3] =
                    bytesPerPixel === 4 && srcIdx + 3 < bmpBuf.length ? bmpBuf[srcIdx + 3] : 255;
            }
        }
    }

    return { width, height, data: rgbaBuf };
}

exports.sendDrawing = async function sendDrawing(bot, req, res, args, discordID, urlQuery = null) {
    try {
        const parsedurl =
            urlQuery !== null
                ? urlQuery
                : Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);

        // Allow sending drawings with or without a message
        const channel = await bot.client.channels.fetch(parsedurl.channel);

        const member = await channel.guild.members.fetch(discordID).catch((err) => {
            console.error(`[sendDrawing] failed to fetch member:`, err);
            return null;
        });
        if (!member) {
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end(
                render('misc/error-text', {
                    MESSAGE:
                        'Failed to verify user permissions. Please ensure you have access to this channel or try again later.',
                })
            );
            return;
        }

        if (!member.permissionsIn(channel).has(discord.PermissionFlagsBits.SendMessages)) {
            res.writeHead(403, { 'Content-Type': 'text/html' });
            res.end(
                render('misc/error-text', {
                    MESSAGE: "You don't have permission to do that!",
                })
            );
            return;
        }

        const webhook = await getOrCreateWebhook(channel, channel.guild.id);

        const rawMsg = convertEmoji(parsedurl.message || '');

        // Process mentions only if there's a message
        const canPingEveryone = canMentionEveryoneIn(member, channel);
        const processedmessage = rawMsg
            ? resolveNameMentions(
                  await resolveMentions(rawMsg, channel.guild),
                  channel.guild,
                  canPingEveryone
              )
            : rawMsg;

        const base64Data = parsedurl.drawinginput;

        // Validate that we have drawing data
        if (!base64Data || base64Data.trim() === '') {
            console.error('[sendDrawing] Error processing image: Input Buffer is empty');
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(
                render('misc/error-text', {
                    MESSAGE: 'No drawing data provided. Please draw something before sending.',
                })
            );
            return;
        }

        // Extract mime type and base64 payload from the data URL
        let base64Image;
        let mimeType = 'image/png';
        if (base64Data.includes(';base64,')) {
            const headerPart = base64Data.split(';base64,')[0];
            if (headerPart.includes(':')) {
                mimeType = headerPart.split(':')[1].trim();
            }
            base64Image = base64Data.split(';base64,').pop();
        } else {
            console.error(
                '[sendDrawing] Error processing image: Data URL does not contain ;base64,'
            );
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(
                render('misc/error-text', {
                    MESSAGE: 'Invalid drawing data format. Please try drawing again.',
                })
            );
            return;
        }

        // Replace spaces with + because URLSearchParams converts + to spaces in form bodies
        base64Image = base64Image.replace(/ /g, '+');

        // Validate the base64 string is not empty
        if (!base64Image || base64Image.trim() === '') {
            console.error('[sendDrawing] Error processing image: Base64 data is empty after split');
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(
                render('misc/error-text', {
                    MESSAGE: 'Invalid drawing data format. Please try again.',
                })
            );
            return;
        }

        let imageBuffer = Buffer.from(base64Image, 'base64');

        // Validate the buffer is not empty or corrupted (e.g. 3-byte garbage)
        if (!imageBuffer || imageBuffer.length < 50) {
            console.error(
                '[sendDrawing] Error processing image: Generated buffer is invalid or too small (' +
                    (imageBuffer ? imageBuffer.length : 0) +
                    ' bytes)'
            );
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(
                render('misc/error-text', {
                    MESSAGE: 'Failed to process drawing data. Please try again.',
                })
            );
            return;
        }

        // If the client sent a BMP (Old 3DS fallback) or the buffer has a BMP header,
        // decode the BMP pixel structure and convert to PNG via sharp so Discord gets a valid PNG.
        const isBmpHeader =
            imageBuffer.length >= 2 && imageBuffer[0] === 0x42 && imageBuffer[1] === 0x4d;
        if (mimeType === 'image/bmp' || mimeType === 'image/x-bmp' || isBmpHeader) {
            try {
                const decoded = decodeBmpToRgba(imageBuffer);
                imageBuffer = await sharp(decoded.data, {
                    raw: {
                        width: decoded.width,
                        height: decoded.height,
                        channels: 4,
                    },
                })
                    .png()
                    .toBuffer();
            } catch (convertErr) {
                console.error('[sendDrawing] BMP→PNG conversion failed:', convertErr);
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end(
                    render('misc/error-text', {
                        MESSAGE: 'Could not process the drawing. Please try again.',
                    })
                );
                return;
            }
        }

        // Discord.js requires Buffer for attachments
        const webhookOptions = {
            username: member.displayName || member.user.tag,
            avatarURL: member.user.avatarURL() || member.user.defaultAvatarURL,
            // Webhooks bypass the member's own mention permissions, so the pings
            // in the optional caption are re-checked against this member's own.
            allowedMentions: buildAllowedMentions(processedmessage, member, channel),
            files: [
                {
                    attachment: imageBuffer,
                    name: 'drawing.png',
                },
            ],
        };

        // Only add content if there's a message
        if (processedmessage && processedmessage.length > 0) {
            webhookOptions.content = processedmessage;
        }

        if (channel.isThread()) {
            webhookOptions.threadId = channel.id;
        }

        const message = await webhook.send(webhookOptions);

        const userAgentStr = req.headers['user-agent'];
        if (userAgentStr && message && message.id) {
            auth.queryRun(
                'INSERT OR REPLACE INTO message_user_agents (messageID, userAgent) VALUES (?, ?)',
                [message.id, userAgentStr]
            );
        }

        bot.addToCache(message);

        res.writeHead(302, { Location: `/channels/${parsedurl.channel}#end` });
        res.end();
    } catch (err) {
        console.error(`[sendDrawing] Error:`, err);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        if ((err.message || err).toString().includes('error reading from remote stream')) {
            res.end(getTemplate('proxy-timeout-error', 'misc'));
        } else {
            res.end(getTemplate('generic-error', 'misc'));
        }
    }
};
