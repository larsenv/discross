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
      // Check if bot is connected
      const clientIsReady = bot && bot.client && (typeof bot.client.isReady === 'function' ? bot.client.isReady() : !!bot.client.uptime);
      
      if (!clientIsReady) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Bot isn't connected" }));
        return;
      }

      // Parse multipart form data
      const form = formidable({ maxFileSize: 8 * 1024 * 1024 }); // 8MB limit
      
      form.parse(req, async (err, fields, files) => {
        if (err) {
          console.error("Error parsing form:", err);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "Failed to parse upload" }));
          return;
        }

        try {
          const channelId = Array.isArray(fields.channel) ? fields.channel[0] : fields.channel;
          const messageText = Array.isArray(fields.message) ? fields.message[0] : fields.message;
          const file = Array.isArray(files.file) ? files.file[0] : files.file;

          if (!file) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "No file provided" }));
            return;
          }

          const channel = await bot.client.channels.fetch(channelId);
          const member = await channel.guild.members.fetch(discordID);

          if (!member.permissionsIn(channel).has(discord.PermissionFlagsBits.SendMessages)) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "No permission to send messages" }));
            return;
          }

          const webhook = await getOrCreateWebhook(channel, channel.guild.id);
          await webhook.edit({ channel: channel });

          // Clean message text (remove uploading placeholder)
          let cleanMessage = messageText ? messageText.replace(/\[Uploading:.*?\]/g, '').trim() : '';

          // Send via webhook
          const message = await webhook.send({
            content: cleanMessage || undefined,
            username: member.displayName || member.user.tag,
            avatarURL: member.user.avatarURL() || member.user.defaultAvatarURL,
            files: [{
              attachment: file.filepath,
              name: file.originalFilename || 'file'
            }]
          });
          
          bot.addToCache(message);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, messageId: message.id }));
        } catch (error) {
          console.error("Error uploading file:", error);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: error.message }));
        }
      });
    });
  } catch (err) {
    console.error("Error in uploadFile:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
};
