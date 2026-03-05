const auth = require('../authentication.js');
const bot = require('../bot.js');
const discord = require('discord.js');
const { convertEmoji } = require('./emojiConvert');
const { getOrCreateWebhook } = require('./webhookCache');
const { strReplace } = require('./utils.js');


exports.replyMessage = async function replyMessage(bot, req, res, args, discordID) {
  try {
    const parsedurl = new URL(req.url, 'http://localhost');
    if (parsedurl.searchParams.get('message') !== "") {
        // Check if bot is connected
        const clientIsReady = bot && bot.client && (typeof bot.client.isReady === 'function' ? bot.client.isReady() : !!bot.client.uptime);
        
        if (!clientIsReady) {
          res.writeHead(503, { "Content-Type": "text/plain" });
          res.write("The bot isn't connected, try again in a moment");
          res.end();
          return;
        }

        const channel = await bot.client.channels.fetch(parsedurl.searchParams.get('channel'));
        if (!channel) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.write("Channel not found");
          res.end();
          return;
        }
        
        let member;
        try {
          member = await channel.guild.members.fetch(discordID);
        } catch (err) {
          console.error("Failed to fetch member:", err);
          res.writeHead(500, { "Content-Type": "text/plain" });
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

        let processedmessage = convertEmoji(parsedurl.searchParams.get('message') || '');
        const regex = /@([^#]{2,32}#\d{4})/g;
        let m;
        do {
          m = regex.exec(processedmessage);
          if (m) {
            let mentioneduser = channel.guild.members.cache.find(member => member.user.tag === m[1]);
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

        let reply_message = await channel.messages.fetch(parsedurl.searchParams.get('reply_message_id'));
        // Verify the reply message belongs to the channel to prevent reply spoofing
        if (reply_message.channelId !== channel.id) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.write("Reply message does not belong to this channel");
          res.end();
          return;
        }
        let reply_message_content = reply_message.content;
        
        // #38: Escape mentions in reply content to prevent ping issues
        reply_message_content = reply_message_content.replace(/<@!?(\d+)>/g, '@user');
        reply_message_content = reply_message_content.replace(/<@&(\d+)>/g, '@role');
        reply_message_content = reply_message_content.replace(/<#(\d+)>/g, '#channel');
        
        if (reply_message_content.length > 30) {
          reply_message_content = reply_message_content.substring(0, 30) + "...";
        }
        
        // #39: Get proper member name for reply
        let author_name = reply_message.author.username;
        try {
          const author_member = await channel.guild.members.fetch(reply_message.author.id);
          author_name = author_member.displayName || author_member.user.username;
        } catch (err) {
          // Use username if member fetch fails
        }

        processedmessage = "> Replying to " + reply_message_content + " from " + author_name + ": [jump](https://discord.com/channels/"+channel.guild.id+"/"+channel.id+"/"+reply_message.id+")\n" + processedmessage;
        
        const message = await webhook.send({
          content: processedmessage,
          username: member.displayName || member.user.tag,
          avatarURL: member.user.avatarURL() || member.user.defaultAvatarURL,
          disableEveryone: true,
        });

        bot.addToCache(message);
      }

      res.writeHead(302, { "Location": `/channels/${parsedurl.searchParams.get('channel')}` });
      res.end();
  } catch (err) {
    console.error("Error sending message:", err);
    res.writeHead(302, { "Location": "/server/" });
    res.end();
  }
};
