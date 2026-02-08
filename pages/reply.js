const url = require('url');
const auth = require('../authentication.js');
const bot = require('../bot.js');
const discord = require('discord.js');

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

exports.replyMessage = async function replyMessage(bot, req, res, args, discordID) {
  try {
    await lock.acquire(discordID, async () => {
      const parsedurl = url.parse(req.url, true);
      if (parsedurl.query.message !== "") {
        // Check if bot is connected
        const clientIsReady = bot && bot.client && (typeof bot.client.isReady === 'function' ? bot.client.isReady() : !!bot.client.uptime);
        
        if (!clientIsReady) {
          res.writeHead(503, { "Content-Type": "text/plain" });
          res.write("The bot isn't connected, try again in a moment");
          res.end();
          return;
        }

        const channel = await bot.client.channels.fetch(parsedurl.query.channel);
        const member = await channel.guild.members.fetch(discordID);

        if (!member.permissionsIn(channel).has(discord.PermissionFlagsBits.SendMessages)) {
          res.write("You don't have permission to do that!");
          res.end();
          return;
        }

        const webhook = await getOrCreateWebhook(channel, channel.guild.id);

        let processedmessage = parsedurl.query.message;
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

        let reply_message = await channel.messages.fetch(parsedurl.query.reply_message_id);
        let reply_message_content = reply_message.content;
        if (reply_message_content.length > 30) {
          reply_message_content = reply_message_content.substring(0, 30) + "...";
        }
        let author_id = reply_message.author.id;
        let author_mention = "<@" + author_id + ">";

        processedmessage = "> Replying to " + reply_message_content + " from " + author_mention + ": [jump](https://discord.com/channels/"+channel.guild.id+"/"+channel.id+"/"+reply_message.id+")\n" + processedmessage;
        
        await webhook.edit({ channel: channel });
        const message = await webhook.send({
          content: processedmessage,
          username: member.displayName || member.user.tag,
          avatarURL: await member.user.avatarURL(),
          disableEveryone: true,
        });

        bot.addToCache(message);
      }

      res.writeHead(302, { "Location": `/channels/${parsedurl.query.channel}` });
      res.end();
    });
  } catch (err) {
    console.error("Error sending message:", err);
    res.writeHead(302, { "Location": "/server/" });
    res.end();
  }
};
