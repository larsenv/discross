const auth = require('../authentication.js');
const bot = require('../bot.js');
const discord = require('discord.js');
const { Buffer } = require('buffer');

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || "");
};

async function clean(server, nodelete) {
  (await server.fetchWebhooks()).forEach(async function (item) {
    if ((item.owner.username.search("Discross") !== -1) && (item.id !== nodelete)) {
      try {
        await item.delete();
      } catch (err) { }
    }
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
const lock = new AsyncLock({ timeout: 30000 }); // 30-second timeout to prevent indefinite queue buildup

// Wrap a promise with a timeout so Discord API calls don't hang the request indefinitely
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Discord API call timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

exports.sendDrawing = async function sendDrawing(bot, req, res, args, discordID, urlQuery = null) {
  try {
    await lock.acquire(discordID, async () => {
      let parsedurl;
      if (urlQuery == null) {
        parsedurl = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
      } else {
        parsedurl = urlQuery;
      }
      // Check bot connectivity before attempting any Discord API calls
      const clientIsReady = bot && bot.client && (typeof bot.client.isReady === 'function' ? bot.client.isReady() : !!bot.client.uptime);
      if (!clientIsReady) {
        res.writeHead(503, { "Content-Type": "text/html" });
        res.write("The bot isn't connected, try again in a moment");
        res.end();
        return;
      }

      // Allow sending drawings with or without a message
      const channel = await withTimeout(bot.client.channels.fetch(parsedurl.channel), 15000);
      let member;
      try {
        member = await withTimeout(channel.guild.members.fetch(discordID), 15000);
      } catch (err) {
        console.error("Failed to fetch member:", err);
        res.writeHead(500, { "Content-Type": "text/html" });
        res.write("Failed to verify user permissions. Please ensure you have access to this channel or try again later.");
        res.end();
        return;
      }

      if (!member.permissionsIn(channel).has(discord.PermissionFlagsBits.SendMessages)) {
        res.write("You don't have permission to do that!");
        res.end();
        return;
      }

      const webhook = await withTimeout(getOrCreateWebhook(channel, channel.guild.id), 15000);
      // webhook is already in the correct channel (fetched via channel.fetchWebhooks()),
      // so webhook.edit() is not needed and could hang if Discord API is slow

      let processedmessage = parsedurl.message || "";

      // Process mentions only if there's a message
      if (processedmessage) {
        const regex = /@([^#]{2,32}#\d{4})/g;
        let m;
        do {
          m = regex.exec(processedmessage);
          if (m) {
            let mentioneduser = await channel.guild.members.cache.find(member => member.user.tag === m[1]);
            if (!mentioneduser) {
              try {
                mentioneduser = (await channel.guild.members.fetch()).find(member => member.user.tag === m[1]);
              } catch (err) {
                console.error("Failed to fetch members for mention:", err);
                // Continue without resolving the mention
              }
            }
            if (mentioneduser) {
              processedmessage = strReplace(processedmessage, m[0], `<@${mentioneduser.id}>`);
            }
          }
        } while (m);
      }

      const base64Data = parsedurl.drawinginput;

      // Validate that we have drawing data
      if (!base64Data || base64Data.trim() === '') {
        console.error('Error processing image: Input Buffer is empty');
        res.writeHead(400, { "Content-Type": "text/html" });
        res.write("No drawing data provided. Please draw something before sending.");
        res.end();
        return;
      }

      // Remove the data URL prefix
      const base64Image = base64Data.split(';base64,').pop();
      
      // Validate the base64 string is not empty
      if (!base64Image || base64Image.trim() === '') {
        console.error('Error processing image: Base64 data is empty after split');
        res.writeHead(400, { "Content-Type": "text/html" });
        res.write("Invalid drawing data format. Please try again.");
        res.end();
        return;
      }

      const imageBuffer = Buffer.from(base64Image, 'base64');
      
      // Validate the buffer is not empty
      if (!imageBuffer || imageBuffer.length === 0) {
        console.error('Error processing image: Generated buffer is empty');
        res.writeHead(400, { "Content-Type": "text/html" });
        res.write("Failed to process drawing data. Please try again.");
        res.end();
        return;
      }

      // Discord.js requires Buffer for attachments
      const webhookOptions = {
        username: member.displayName || member.user.tag,
        avatarURL: member.user.avatarURL() || member.user.defaultAvatarURL,
        files: [{
          attachment: imageBuffer,
          name: "drawing.png"
        }]
      };
      
      // Only add content if there's a message
      if (processedmessage && processedmessage.length > 0) {
        webhookOptions.content = processedmessage;
      }
      
      const message = await withTimeout(webhook.send(webhookOptions), 30000);
      bot.addToCache(message);
      
      console.log("Redirecting to channel...");
      res.writeHead(302, { "Location": `/channels/${parsedurl.channel}#end` });
      res.end();
    });
  } catch (err) {
    console.error("Error sending message:", err);
    res.writeHead(500, { "Content-Type": "text/html" });
    res.write("An error occurred! Please try again later.<br>"); //write a response to the client
    res.end();
  }
};