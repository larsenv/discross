const url = require('url');
const auth = require('../authentication.js');
const bot = require('../bot.js');
const discord = require('discord.js');

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || "");
};

// https://stackoverflow.com/questions/1967119/why-does-javascript-replace-only-first-instance-when-using-replace

async function clean(server, nodelete) {
  (await server.fetchWebhooks()).forEach(async function (item) {
    if ((item.owner.username.search("Discross") != -1) && (item.id != nodelete)) {
      try {
        await item.delete();
      } catch (err) { }
    }
  });
}

const AsyncLock = require('async-lock');
const lock = new AsyncLock(); // Create a new lock instance

exports.sendMessage = async function sendMessage(bot, req, res, args, discordID) {
  try {
    // Lock the code execution for this discordID
    await lock.acquire(discordID, async () => {
      parsedurl = url.parse(req.url, true);
      
      if (parsedurl.query.message != "") {
        const channel = await bot.client.channels.fetch(parsedurl.query.channel);
        const member = await channel.guild.members.fetch(discordID);
        const user = member.user;
        let username = user.tag;

        if (member.displayName != user.username) {
          username = member.displayName + " (@" + user.tag + ")";
        }

        if (!member.permissionsIn(channel).has(discord.PermissionFlagsBits.SendMessages, true)) {
          res.write("You don't have permission to do that!");
          res.end();
          return;
        }

        // Webhook handling
        webhookDB = auth.dbQuerySingle("SELECT * FROM webhooks WHERE serverID=?", [channel.guild.id]);

        let webhook;
        if (!webhookDB) {
          webhook = await channel.createWebhook({ name: "Discross", avatar: "pages/static/resources/logo.png", reason: "Discross uses webhooks to send messages" });
          auth.dbQueryRun("INSERT INTO webhooks VALUES (?,?,?)", [channel.guild.id, webhook.id, webhook.token]);
          clean(channel.guild, webhook.id); // Clean up all webhooks except the new one
        } else {
          try {
            webhook = await bot.client.fetchWebhook(webhookDB.webhookID);
          } catch (err) {
            webhook = await channel.createWebhook({ name: "Discross", avatar: "pages/static/resources/logo.png", reason: "Discross uses webhooks to send messages" });
            auth.dbQueryRun("INSERT INTO webhooks VALUES (?,?,?)", [channel.guild.id, webhook.id, webhook.token]);
            clean(channel.guild, webhook.id); // Clean up all webhooks except the new one
          }
          clean(channel.guild, webhookDB.webhookID);
        }

        let processedmessage = parsedurl.query.message;

        // Regex to detect user mentions
        var regex = /@([^#]{2,32}#\d{4})/g;
        var m;

        do {
          m = regex.exec(processedmessage);
          if (m) {
            mentioneduser = await channel.guild.members.cache.find(member => member.user.tag == m[1]);
            if (!mentioneduser) {
              mentioneduser = (await channel.guild.members.fetch()).find(member => member.user.tag == m[1]);
            }
            if (mentioneduser) {
              processedmessage = strReplace(processedmessage, m[0], "<@" + mentioneduser.id + ">");
            }
          }
        } while (m);

        await webhook.edit({ channel: channel });
        const message = await webhook.send({
          content: processedmessage,
          username: username,
          avatarURL: user.avatarURL(),
          disableEveryone: true
        });

        bot.addToCache(message);
      }

      res.writeHead(302, { "Location": "/channels/" + parsedurl.query.channel + "#end" });
      res.end();
    });
  } catch (err) {
    res.writeHead(302, { "Location": "/server/" });
    res.end();
  }
}
