const fs = require('fs');
const url = require('url');
const https = require('https');
const auth = require('../authentication.js');
const bot = require('../bot.js');
const discord = require('discord.js');
const { Buffer } = require('buffer');
const { formidable } = require('formidable');
const escapeHtml = require('escape-html');

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || "");
};

// Upload file to transfer.notkiska.pw and return the URL
async function uploadToTransfer(filePath, filename) {
  return new Promise((resolve, reject) => {
    // Sanitize filename - remove path traversal and keep only safe characters
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    
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
        hostname: 'transfer.notkiska.pw',
        port: 443,
        path: `/${encodeURIComponent(sanitizedFilename)}`,
        method: 'PUT',
        headers: {
          'Content-Length': stats.size
        },
        // Set a high timeout for large files (15 minutes = 15 * 60 * 1000 ms)
        timeout: 15 * 60 * 1000
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
              reject(new Error(`Invalid or insecure URL received from transfer service: ${transferUrl}`));
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

async function getOrCreateWebhook(channel, guildID) {
  try {
    const existingWebhooks = await channel.fetchWebhooks();
    let webhook = existingWebhooks.find(w => w.owner.username === "discross beta" || w.owner.username === "Discross");

    if (!webhook) {
      webhook = await channel.createWebhook({
        name: "Discross",
        avatar: "pages/static/resources/logo.png",
        reason: "Discross uses webhooks to send messages",
      });
      auth.dbQueryRun("INSERT INTO webhooks VALUES (?,?,?)", [guildID, webhook.id, webhook.token]);
    }
    return webhook;
  } catch (err) {
    console.error("Error fetching/creating webhook:", err);
    throw err;
  }
}

const AsyncLock = require('async-lock');
const lock = new AsyncLock();

exports.uploadFile = async function uploadFile(bot, req, res, args, discordID) {
  try {
    await lock.acquire(discordID, async () => {
      const clientIsReady = bot && bot.client && (typeof bot.client.isReady === 'function' ? bot.client.isReady() : !!bot.client.uptime);

      // Detect if this is a traditional form submission (for older browsers like 3DS)
      // Check for explicit query parameter first, then fallback to Accept header
      const parsedUrl = url.parse(req.url, true);
      const isTraditionalSubmission = parsedUrl.query.traditional === 'true';

      if (!clientIsReady) {
        if (isTraditionalSubmission) {
          res.writeHead(503, { "Content-Type": "text/html" });
          res.end("<script>alert('Bot isn\\'t connected'); history.back();</script>");
        } else {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "Bot isn't connected" }));
        }
        return;
      }

      const form = formidable({ maxFileSize: 498 * 1024 * 1024 });

      // Wrap form.parse in a Promise so the Lock actually waits for the upload to finish
      await new Promise((resolve, reject) => {
        form.parse(req, async (err, fields, files) => {
          if (err) {
            console.error("Error parsing form:", err);
            if (isTraditionalSubmission) {
              res.writeHead(400, { "Content-Type": "text/html" });
              res.end("<script>alert('Failed to parse upload'); history.back();</script>");
            } else {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: false, error: "Failed to parse upload" }));
            }
            resolve(); // Resolve lock
            return;
          }

          try {
            const channelId = Array.isArray(fields.channel) ? fields.channel[0] : fields.channel;
            const messageText = Array.isArray(fields.message) ? fields.message[0] : fields.message;
            
            // Get the file object safely
            const fileObj = files.file || Object.values(files)[0]; // Fallback if input name isn't 'file'
            const file = Array.isArray(fileObj) ? fileObj[0] : fileObj;

            if (!file) {
              if (isTraditionalSubmission) {
                res.writeHead(400, { "Content-Type": "text/html" });
                res.end("<script>alert('No file provided'); history.back();</script>");
              } else {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: false, error: "No file provided" }));
              }
              resolve();
              return;
            }

            // SUPPORT BOTH VERSIONS OF FORMIDABLE (v1 uses .path, v2/v3 uses .filepath)
            const filePath = file.filepath || file.path;

            const channel = await bot.client.channels.fetch(channelId);
            const member = await channel.guild.members.fetch(discordID);

            if (!member.permissionsIn(channel).has(discord.PermissionFlagsBits.SendMessages)) {
              if (isTraditionalSubmission) {
                res.writeHead(403, { "Content-Type": "text/html" });
                res.end("<script>alert('No permission to send messages'); history.back();</script>");
              } else {
                res.writeHead(403, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: false, error: "No permission to send messages" }));
              }
              resolve();
              return;
            }

            const webhook = await getOrCreateWebhook(channel, channel.guild.id);
            if (webhook.channelId !== channel.id) {
                 await webhook.edit({ channel: channel.id });
            }

            let cleanMessage = messageText ? messageText.replace(/\[Uploading:.*?\]/g, '').trim() : '';

            // Upload file to transfer.notkiska.pw
            let transferUrl;
            try {
              transferUrl = await uploadToTransfer(filePath, file.originalFilename || file.name || 'uploaded_file');
            } catch (uploadError) {
              console.error("Error uploading to transfer.notkiska.pw:", uploadError);
              if (isTraditionalSubmission) {
                res.writeHead(500, { "Content-Type": "text/html" });
                const escapedMessage = escapeHtml(uploadError.message);
                res.end("<script>alert('Failed to upload file: " + escapedMessage.replace(/'/g, "\\'") + "'); history.back();</script>");
              } else {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: false, error: "Failed to upload file: " + uploadError.message }));
              }
              resolve();
              return;
            }

            // Send message with just the transfer.notkiska.pw URL as a link
            const message = await webhook.send({
              content: transferUrl,
              username: member.displayName || member.user.tag,
              avatarURL: member.user.avatarURL() || member.user.defaultAvatarURL
            });

            bot.addToCache(message);

            // Return response based on submission type
            if (isTraditionalSubmission) {
              // Redirect back to the channel for traditional submissions
              res.writeHead(302, { "Location": `/channels/${channelId}` });
              res.end();
            } else {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: true, messageId: message.id }));
            }
            resolve();

          } catch (error) {
            console.error("Error uploading file:", error);
            // Only send headers if not already sent
            if (!res.headersSent) {
                if (isTraditionalSubmission) {
                  res.writeHead(500, { "Content-Type": "text/html" });
                  const escapedMessage = escapeHtml(error.message);
                  res.end("<script>alert('Error: " + escapedMessage.replace(/'/g, "\\'") + "'); history.back();</script>");
                } else {
                  res.writeHead(500, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ success: false, error: error.message }));
                }
            }
            resolve();
          }
        });
      });
    });
  } catch (err) {
    console.error("Error in uploadFile:", err);
    if (!res.headersSent) {
        // Re-parse URL to check for traditional submission flag
        const parsedUrl = url.parse(req.url, true);
        const isTraditionalSubmission = parsedUrl.query.traditional === 'true';
        if (isTraditionalSubmission) {
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end("<script>alert('Internal Server Error'); history.back();</script>");
        } else {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
    }
  }
};