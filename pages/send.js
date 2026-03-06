'use strict';
const discord = require('discord.js');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const { convertEmoji } = require('./emojiConvert');
const { getOrCreateWebhook } = require('./webhookCache');
const { isValidSnowflake, isBotReady, getBaseUrl, resolveMentions } = require('./utils.js');

exports.sendMessage = async function sendMessage(bot, req, res, args, discordID) {
  const baseUrl = getBaseUrl(req);
  try {
    const parsedurl = new URL(req.url, 'http://localhost');
    const query = Object.fromEntries(parsedurl.searchParams);

    // Ensure message exists and is a non-empty string
    if (typeof query.message === 'string' && query.message !== '') {
      const channelId = query.channel || query.channel_id || args?.[2];

      // Check if bot is connected
      if (!isBotReady(bot)) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end("The bot isn't connected, try again in a moment");
        return;
      }

      // Validate channel id format early
      if (!channelId || !isValidSnowflake(channelId)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Invalid channel!');
        return;
      }

      // Attempt to fetch channel, handle failures gracefully
      const channel = await bot.client.channels.fetch(channelId).catch((err) => {
        console.error('Channel fetch error:', err);
        return null;
      });

      if (!channel) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Invalid channel!');
        return;
      }

      // Attempt to fetch member and check permissions
      const member = await channel.guild.members.fetch(discordID).catch((err) => {
        console.error('Member fetch error:', err);
        return null;
      });

      if (!member || !member.permissionsIn(channel).has(discord.PermissionFlagsBits.SendMessages)) {
        res.end("You don't have permission to do that!");
        return;
      }

      const webhook = await getOrCreateWebhook(channel, channel.guild.id);

      let processedmessage = await resolveMentions(
        convertEmoji(query.message || ''),
        channel.guild
      );

      // Handle reply if reply_message_id is present
      if (query.reply_message_id && isValidSnowflake(query.reply_message_id)) {
        try {
          const reply_message = await channel.messages.fetch(query.reply_message_id);
          // Verify the reply message belongs to the channel to prevent reply spoofing
          if (reply_message.channelId !== channel.id) {
            throw new Error('Reply message does not belong to this channel');
          }
          const reply_message_content =
            reply_message.content.length > 30
              ? `${reply_message.content.substring(0, 30)}...`
              : reply_message.content;
          const author_id = reply_message.author.id;
          const author_mention = `<@${author_id}>`;

          processedmessage = `> Replying to "${reply_message_content}" from ${author_mention}: [jump](https://discord.com/channels/${channel.guild.id}/${channel.id}/${reply_message.id})\n${processedmessage}`;
        } catch (err) {
          console.error('Failed to reply:', err);
        }
      }

      const sendOptions = {
        content: processedmessage,
        username: normalizeWeirdUnicode(member.displayName || member.user.tag),
        avatarURL: member.user.avatarURL() || member.user.defaultAvatarURL,
        disableEveryone: true,
      };
      if (channel.isThread()) {
        sendOptions.threadId = channel.id;
      }
      const message = await webhook.send(sendOptions);

      bot.addToCache(message);
    }

    // redirect back to the channel (use the provided channel id if available)
    const redirectChannel = parsedurl.searchParams.get('channel') || args?.[2] || '';
    const sessionID = parsedurl.searchParams.get('sessionID') || '';
    const sessionPart = sessionID ? `?sessionID=${encodeURIComponent(sessionID)}` : '';
    res.writeHead(302, { Location: `${baseUrl}/channels/${redirectChannel}${sessionPart}` });
    res.end();
  } catch (err) {
    console.error('Error sending message:', err);
    res.writeHead(302, { Location: `${baseUrl}/server/` });
    res.end();
  }
};
