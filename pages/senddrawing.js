const url = require('url');
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
      if (parsedurl.message !== "") {
        const channel = await bot.client.channels.fetch(parsedurl.channel);
        const member = await channel.guild.members.fetch(discordID);

        if (!member.permissionsIn(channel).has(discord.PermissionFlagsBits.SendMessages)) {
          res.write("You don't have permission to do that!");
          res.end();
          return;
        }

        const webhook = await getOrCreateWebhook(channel, channel.guild.id);

        let processedmessage = parsedurl.message;
        const regex = /@([^#]{2,32}#\d{4})/g;
        let m;
        do {
          m = regex.exec(processedmessage);
          if (m) {
            let mentioneduser = await channel.guild.members.cache.find(member => member.user.tag === m[1]);
            if (!mentioneduser) {
              mentioneduser = (await channel.guild.members.fetch()).find(member => member.user.tag === m[1]);
            }
            if (mentioneduser) {
              processedmessage = strReplace(processedmessage, m[0], `<@${mentioneduser.id}>`);
            }
          }
        } while (m);
        await webhook.edit({ channel: channel });
        const base64Data = parsedurl.drawinginput;

        // Remove the data URL prefix
        const base64Image = base64Data.split(';base64,').pop();
        const imageBuffer = Buffer.from(base64Image, 'base64');

        const messageCont = "";

        if (processedmessage) {
          messageCont = processedmessage;
        }

        const message = await webhook.send({
          content: messageCont,
          username: member.displayName || member.user.tag,
          avatarURL: await member.user.avatarURL(),
          files: [{ attachment: imageBuffer, name: "image.png" }]
        });
        bot.addToCache(message);
      }
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