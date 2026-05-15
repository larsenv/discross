'use strict';
const fs = require('fs');
const https = require('https');
const bot = require('../src/bot.js');
const discord = require('discord.js');
const auth = require('../src/authentication.js');
const { formidable } = require('formidable');
const { isBotReady, getTemplate, renderTemplate, render } = require('./utils.js');
const { getOrCreateWebhook } = require('./webhookCache');
const mime = require('mime-types');

// Upload file to transfer.archivete.am and return the URL
async function uploadToTransfer(filePath, filename) {
    return new Promise((resolve, reject) => {
        // Sanitize filename - remove path traversal and keep only safe characters
        const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const contentType = mime.lookup(filename) || 'application/octet-stream';

        const fileStream = fs.createReadStream(filePath);

        // Handle file stream errors
        fileStream.on('error', (err) => {
            reject(new Error(`Failed to read file: ${err.message}`));
        });

        // Get file size asynchronously
        fs.stat(filePath, (statErr, stats) => {
            if (statErr) {
                reject(new Error(`Failed to get file stats: ${statErr.message}`));
                return;
            }

            const options = {
                hostname: 'transfer.archivete.am',
                port: 443,
                path: `/${encodeURIComponent(sanitizedFilename)}`,
                method: 'PUT',
                headers: {
                    'Content-Length': stats.size,
                    'Content-Type': contentType,
                },
                // Set a high timeout for large files (30 minutes = 30 * 60 * 1000 ms)
                timeout: 30 * 60 * 1000,
            };

            const req = https.request(options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    if (res.statusCode === 200 || res.statusCode === 201) {
                        // The response should contain the URL to download the file
                        const transferUrl = data.trim();

                        // Validate that the response is a valid HTTPS URL for security
                        if (!transferUrl || !transferUrl.startsWith('https://')) {
                            reject(
                                new Error(
                                    `Invalid or insecure URL received from transfer service: ${transferUrl}`
                                )
                            );
                            return;
                        }

                        resolve(transferUrl);
                    } else {
                        reject(new Error(`Upload failed with status ${res.statusCode}: ${data}`));
                    }
                });
            });

            req.on('error', (err) => {
                reject(err);
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Upload timeout - file may be too large'));
            });

            fileStream.pipe(req);
        });
    });
}

const AsyncLock = require('async-lock');
const lock = new AsyncLock();

exports.uploadFile = async function uploadFile(bot, req, res, args, discordID) {
    try {
        await lock.acquire(discordID, async () => {
            // Detect if this is a traditional form submission (for older browsers like 3DS)
            // Check for explicit query parameter
            const parsedUrl = new URL(req.url, 'http://localhost');
            const isTraditionalSubmission = parsedUrl.searchParams.get('traditional') === 'true';

            if (!isBotReady(bot)) {
                if (isTraditionalSubmission) {
                    res.writeHead(503, { 'Content-Type': 'text/html' });
                    res.end(
                        render('misc/script-alert-back', {
                            MESSAGE: 'Bot is not connected',
                        })
                    );
                } else {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: "Bot isn't connected" }));
                }
                return;
            }

            const form = formidable({
                maxFileSize: 498 * 1024 * 1024,
                allowEmptyFiles: false,
            });

            // Wrap form.parse in a Promise so the Lock actually waits for the upload to finish
            await new Promise((resolve, reject) => {
                form.parse(req, async (err, fields, files) => {
                    if (err) {
                        console.log('Error parsing form:', err.message || err);
                        if (isTraditionalSubmission) {
                            res.writeHead(400, { 'Content-Type': 'text/html' });
                            res.end(
                                render('misc/script-alert-back', {
                                    MESSAGE: 'Failed to parse upload',
                                })
                            );
                        } else {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(
                                JSON.stringify({ success: false, error: 'Failed to parse upload' })
                            );
                        }
                        resolve(); // Resolve lock
                        return;
                    }

                    try {
                        const channelId = Array.isArray(fields.channel)
                            ? fields.channel[0]
                            : fields.channel;
                        if (!channelId || channelId === 'undefined') {
                            if (isTraditionalSubmission) {
                                res.writeHead(400, { 'Content-Type': 'text/html' });
                                res.end(
                                    render('misc/script-alert-back', {
                                        MESSAGE: 'Invalid channel',
                                    })
                                );
                            } else {
                                res.writeHead(400, { 'Content-Type': 'application/json' });
                                res.end(
                                    JSON.stringify({ success: false, error: 'Invalid channel' })
                                );
                            }
                            resolve();
                            return;
                        }

                        // Get the file object safely
                        const fileObj = files.file || Object.values(files)[0]; // Fallback if input name isn't 'file'
                        const file = Array.isArray(fileObj) ? fileObj[0] : fileObj;

                        if (!file || file.size === 0) {
                            const errorMsg = !file ? 'No file provided' : 'Uploaded file is empty';
                            console.log(`Upload error: ${errorMsg}`);
                            if (isTraditionalSubmission) {
                                res.writeHead(400, { 'Content-Type': 'text/html' });
                                res.end(
                                    render('misc/script-alert-back', {
                                        MESSAGE: errorMsg,
                                    })
                                );
                            } else {
                                res.writeHead(400, { 'Content-Type': 'application/json' });
                                res.end(
                                    JSON.stringify({ success: false, error: errorMsg })
                                );
                            }
                            resolve();
                            return;
                        }

                        const originalFilename = file.originalFilename || file.name || 'uploaded_file';
                        const isMKV = originalFilename.toLowerCase().endsWith('.mkv');

                        const messageText = Array.isArray(fields.message)
                            ? fields.message[0]
                            : fields.message;
                        const rawSessionId =
                            (Array.isArray(fields.sessionID)
                                ? fields.sessionID[0]
                                : fields.sessionID) || '';
                        // Validate sessionID to prevent open redirect; allow alphanumeric, hyphens, underscores (covers UUIDs and other session formats)
                        const sessionId = /^[a-zA-Z0-9_-]{1,128}$/.test(rawSessionId)
                            ? rawSessionId
                            : '';

                        // Log upload start
                        console.log(`Starting upload to transfer service: ${originalFilename} (${file.size} bytes)`);

                        // Basic sanity check for common file types
                        if (isMKV && file.size < 1024 * 50) { // MKV headers alone are usually a few KB, but 50KB is a very safe "is this even a video" floor
                            console.warn(`Warning: MKV file ${originalFilename} is suspiciously small (${file.size} bytes).`);
                        }

                        // SUPPORT BOTH VERSIONS OF FORMIDABLE (v1 uses .path, v2/v3 uses .filepath)
                        const filePath = file.filepath || file.path;

                        const channel = await bot.client.channels.fetch(channelId);
                        const member = await channel.guild.members.fetch(discordID);

                        if (
                            !member
                                .permissionsIn(channel)
                                .has(discord.PermissionFlagsBits.SendMessages)
                        ) {
                            if (isTraditionalSubmission) {
                                res.writeHead(403, { 'Content-Type': 'text/html' });
                                res.end(
                                    render('misc/script-alert-back', {
                                        MESSAGE: 'No permission to send messages',
                                    })
                                );
                            } else {
                                res.writeHead(403, { 'Content-Type': 'application/json' });
                                res.end(
                                    JSON.stringify({
                                        success: false,
                                        error: 'No permission to send messages',
                                    })
                                );
                            }
                            resolve();
                            return;
                        }

                        let webhook;
                        try {
                            webhook = await getOrCreateWebhook(channel, channel.guild.id);
                            if (webhook.channelId !== channel.id) {
                                await webhook.edit({ channel: channel.id });
                            }
                        } catch (err) {
                            console.log('Webhook error:', err.message || err);
                            if (isTraditionalSubmission) {
                                res.writeHead(403, { 'Content-Type': 'text/html' });
                                res.end(
                                    render('misc/script-alert-back', {
                                        MESSAGE:
                                            'Failed to send message. Discross needs "Manage Webhooks" permission.',
                                    })
                                );
                            } else {
                                res.writeHead(403, { 'Content-Type': 'application/json' });
                                res.end(
                                    JSON.stringify({
                                        success: false,
                                        error: 'Failed to send message. Discross needs "Manage Webhooks" permission.',
                                    })
                                );
                            }
                            resolve();
                            return;
                        }

                        const cleanMessage = messageText
                            ? messageText.replace(/\[Uploading:.*?\]/g, '').trim()
                            : '';

                        // Upload file to transfer.archivete.am
                        const transferUrl = await uploadToTransfer(
                            filePath,
                            file.originalFilename || file.name || 'uploaded_file'
                        ).catch((uploadError) => {
                            console.error('Error uploading to transfer.archivete.am:', uploadError);
                            if (isTraditionalSubmission) {
                                res.writeHead(500, { 'Content-Type': 'text/html' });
                                const safeMessage = JSON.stringify(
                                    'Failed to upload file: ' + uploadError.message
                                );
                                res.end(
                                    render('misc/script-alert-back', {
                                        MESSAGE: 'Failed to upload file: ' + uploadError.message,
                                    })
                                );
                            } else {
                                res.writeHead(500, { 'Content-Type': 'application/json' });
                                res.end(
                                    JSON.stringify({
                                        success: false,
                                        error: 'Failed to upload file: ' + uploadError.message,
                                    })
                                );
                            }
                            resolve();
                            return undefined;
                        });
                        if (transferUrl === undefined) return;

                        // Send message with just the transfer.archivete.am URL as a link
                        const message = await webhook.send({
                            content: transferUrl,
                            username: member.displayName || member.user.tag,
                            avatarURL: member.user.avatarURL() || member.user.defaultAvatarURL,
                        });

                        const userAgentStr = req.headers['user-agent'];
                        if (userAgentStr && message && message.id) {
                            auth.dbQueryRun(
                                'INSERT OR REPLACE INTO message_user_agents (messageID, userAgent) VALUES (?, ?)',
                                [message.id, userAgentStr]
                            );
                        }

                        bot.addToCache(message);

                        // Return response based on submission type
                        if (isTraditionalSubmission) {
                            // Redirect back to the channel for traditional submissions
                            const redirectPath = sessionId
                                ? `/channels/${channelId}?sessionID=${encodeURIComponent(sessionId)}`
                                : `/channels/${channelId}`;
                            res.writeHead(302, { Location: redirectPath });
                            res.end();
                        } else {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: true, messageId: message.id }));
                        }
                        resolve();
                    } catch (error) {
                        console.error('Error uploading file:', error);
                        // Only send headers if not already sent
                        if (!res.headersSent) {
                            if (isTraditionalSubmission) {
                                res.writeHead(500, { 'Content-Type': 'text/html' });
                                res.end(
                                    render('misc/script-alert-back', {
                                        MESSAGE: 'Error: ' + error.message,
                                    })
                                );
                            } else {
                                res.writeHead(500, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ success: false, error: error.message }));
                            }
                        }
                        resolve();
                    }
                });
            });
        });
    } catch (err) {
        console.error('Error in uploadFile:', err);
        if (!res.headersSent) {
            // Re-parse URL to check for traditional submission flag
            const parsedUrl = new URL(req.url, 'http://localhost');
            const isTraditionalSubmission = parsedUrl.searchParams.get('traditional') === 'true';
            if (isTraditionalSubmission) {
                res.writeHead(500, { 'Content-Type': 'text/html' });
                res.end(
                    render('misc/script-alert-back', {
                        MESSAGE: 'Internal Server Error',
                    })
                );
            } else {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            }
        }
    }
};
