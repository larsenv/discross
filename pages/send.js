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

function isValidSnowflake(id) {
  return typeof id === 'string' && /^[0-9]{16,20}$/.test(id);
}

exports.sendMessage = async function sendMessage(bot, req, res, args, discordID) {
  try {
    await lock.acquire(discordID, async () => {
      const parsedurl = url.parse(req.url, true);
      const query = parsedurl.query || {};

      // Ensure message exists and is a non-empty string
      if (typeof query.message === 'string' && query.message !== "") {
        const channelId = (query.channel || query.channel_id || args?.[2]);

        // Check if bot is connected
        const clientIsReady = bot && bot.client && (typeof bot.client.isReady === 'function' ? bot.client.isReady() : !!bot.client.uptime);
        
        if (!clientIsReady) {
          res.writeHead(503, { "Content-Type": "text/plain" });
          res.write("The bot isn't connected, try again in a moment");
          res.end();
          return;
        }

        // Validate channel id format early
        if (!channelId || !isValidSnowflake(channelId)) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.write("Invalid channel!");
          res.end();
          return;
        }

        // Attempt to fetch channel, handle failures gracefully
        let channel;
        try {
          channel = await bot.client.channels.fetch(channelId);
        } catch (err) {
          console.error("Channel fetch error:", err);
          channel = null;
        }

        if (!channel) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.write("Invalid channel!");
          res.end();
          return;
        }

        // Attempt to fetch member and check permissions
        let member;
        try {
          member = await channel.guild.members.fetch(discordID);
        } catch (err) {
          console.error("Member fetch error:", err);
          member = null;
        }

        if (!member || !member.permissionsIn(channel).has(discord.PermissionFlagsBits.SendMessages)) {
          res.write("You don't have permission to do that!");
          res.end();
          return;
        }

        const webhook = await getOrCreateWebhook(channel, channel.guild.id);

        let processedmessage = query.message;
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

        // Handle reply if reply_message_id is present
        if (query.reply_message_id && isValidSnowflake(query.reply_message_id)) {
          try {
            let reply_message = await channel.messages.fetch(query.reply_message_id);
            let reply_message_content = reply_message.content;
            if (reply_message_content.length > 30) {
              reply_message_content = reply_message_content.substring(0, 30) + "...";
            }
            let author_id = reply_message.author.id;
            let author_mention = `<@${author_id}>`;

            processedmessage = `> Replying to "${reply_message_content}" from ${author_mention}: [jump](https://discord.com/channels/${channel.guild.id}/${channel.id}/${reply_message.id})\n${processedmessage}`;
          } catch (err) {
            console.error("Failed to reply:", err);
          }
        }

        try {
          await webhook.edit({ channel: channel });
        } catch (err) {
          // Editing webhook channel can fail if missing permissions; log but continue to attempt send
          console.error("Failed to edit webhook channel:", err);
        }

        const message = await webhook.send({
          content: processedmessage,
          username: member.displayName || member.user.tag,
          avatarURL: await member.user.avatarURL(),
          disableEveryone: true,
        });

        bot.addToCache(message);
      }

      // redirect back to the channel (use the provided channel id if available)
      const redirectChannel = (parsedurl.query && parsedurl.query.channel) ? parsedurl.query.channel : (args?.[2] || "");
      res.writeHead(302, { "Location": `/channels/${redirectChannel}` });
      res.end();
    });
  } catch (err) {
    console.error("Error sending message:", err);
    res.writeHead(302, { "Location": "/server/" });
    res.end();
  }
};
