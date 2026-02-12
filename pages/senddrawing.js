const url = require('url');
const auth = require('../authentication.js');
const bot = require('../bot.js');
const discord = require('discord.js');
const { Buffer } = require('buffer');
const { AttachmentBuilder } = discord;

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
const lock = new AsyncLock(); // Create a new lock instance

exports.sendDrawing = async function sendDrawing(bot, req, res, args, discordID, urlQuery = null) {
  try {
    await lock.acquire(discordID, async () => {
      let parsedurl;
      if (urlQuery == null) {
        parsedurl = url.parse(req.url, true).query;
      } else {
        parsedurl = urlQuery;
      }
      // Allow sending drawings with or without a message
      const channel = await bot.client.channels.fetch(parsedurl.channel);
      let member;
      try {
        member = await channel.guild.members.fetch(discordID);
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

      const webhook = await getOrCreateWebhook(channel, channel.guild.id);

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
      
      await webhook.edit({ channel: channel });
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

      // Create AttachmentBuilder for Discord.js v14
      const attachment = new AttachmentBuilder(imageBuffer, { name: "image.png" });

      const message = await webhook.send({
        content: processedmessage,
        username: member.displayName || member.user.tag,
        avatarURL: member.user.avatarURL() || member.user.defaultAvatarURL,
        files: [attachment]
      });
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