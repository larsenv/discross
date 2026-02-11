const fs = require('fs');
const url = require('url');
const auth = require('../authentication.js');
const bot = require('../bot.js');
const discord = require('discord.js');
const { Buffer } = require('buffer');
const { formidable } = require('formidable');

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || "");
};

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

      if (!clientIsReady) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Bot isn't connected" }));
        return;
      }

      const form = formidable({ maxFileSize: 8 * 1024 * 1024 });

      // Wrap form.parse in a Promise so the Lock actually waits for the upload to finish
      await new Promise((resolve, reject) => {
        form.parse(req, async (err, fields, files) => {
          if (err) {
            console.error("Error parsing form:", err);
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "Failed to parse upload" }));
            resolve(); // Resolve lock
            return;
          }

          const channel = await bot.client.channels.fetch(channelId);
          let member;
          try {
            member = await channel.guild.members.fetch(discordID);
          } catch (err) {
            console.error("Failed to fetch member:", err);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "Failed to verify user permissions. Please ensure you have access to this channel." }));
            return;
          }
          
          try {
            const channelId = Array.isArray(fields.channel) ? fields.channel[0] : fields.channel;
            const messageText = Array.isArray(fields.message) ? fields.message[0] : fields.message;
            
            // Get the file object safely
            const fileObj = files.file || Object.values(files)[0]; // Fallback if input name isn't 'file'
            const file = Array.isArray(fileObj) ? fileObj[0] : fileObj;

            if (!file) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: false, error: "No file provided" }));
              resolve();
              return;
            }

            // SUPPORT BOTH VERSIONS OF FORMIDABLE (v1 uses .path, v2/v3 uses .filepath)
            const filePath = file.filepath || file.path;

            const channel = await bot.client.channels.fetch(channelId);
            const member = await channel.guild.members.fetch(discordID);

            if (!member.permissionsIn(channel).has(discord.PermissionFlagsBits.SendMessages)) {
              res.writeHead(403, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: false, error: "No permission to send messages" }));
              resolve();
              return;
            }

            const webhook = await getOrCreateWebhook(channel, channel.guild.id);
            if (webhook.channelId !== channel.id) {
                 await webhook.edit({ channel: channel.id });
            }

            let cleanMessage = messageText ? messageText.replace(/\[Uploading:.*?\]/g, '').trim() : '';

            // VITAL FIX: Use fs.createReadStream
            const message = await webhook.send({
              content: cleanMessage || undefined,
              username: member.displayName || member.user.tag,
              avatarURL: member.user.avatarURL() || member.user.defaultAvatarURL,
              files: [{
                attachment: fs.createReadStream(filePath), 
                name: file.originalFilename || file.name || 'uploaded_file'
              }]
            });

            bot.addToCache(message);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, messageId: message.id }));
            resolve();

          } catch (error) {
            console.error("Error uploading file:", error);
            // Only send headers if not already sent
            if (!res.headersSent) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: false, error: error.message }));
            }
            resolve();
          }
        });
      });
    });
  } catch (err) {
    console.error("Error in uploadFile:", err);
    if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }
};