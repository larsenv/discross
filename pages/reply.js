'use strict';
const discord = require('discord.js');
const { convertEmoji } = require('./emojiConvert');
const { getOrCreateWebhook } = require('./webhookCache');
const { isBotReady, resolveMentions } = require('./utils.js');

exports.replyMessage = async function replyMessage(bot, req, res, args, discordID) {
  try {
    const parsedurl = new URL(req.url, 'http://localhost');
    if (
      parsedurl.searchParams.get('message') !== null &&
      parsedurl.searchParams.get('message') !== ''
    ) {
      // Check if bot is connected
      if (!isBotReady(bot)) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end("The bot isn't connected, try again in a moment");
        return;
      }

      const channel = await bot.client.channels.fetch(parsedurl.searchParams.get('channel'));
      if (!channel) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Channel not found');
        return;
      }

      let member;
      try {
        member = await channel.guild.members.fetch(discordID);
      } catch (err) {
        console.error('Failed to fetch member:', err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(
          'Failed to verify user permissions. Please ensure you have access to this channel or try again later.'
        );
        return;
      }

      if (!member.permissionsIn(channel).has(discord.PermissionFlagsBits.SendMessages)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end("You don't have permission to do that!");
        return;
      }

      const webhook = await getOrCreateWebhook(channel, channel.guild.id);

      let processedmessage = await resolveMentions(
        convertEmoji(parsedurl.searchParams.get('message') || ''),
        channel.guild
      );

      const reply_message = await channel.messages.fetch(
        parsedurl.searchParams.get('reply_message_id')
      );
      // Verify the reply message belongs to the channel to prevent reply spoofing
      if (reply_message.channelId !== channel.id) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Reply message does not belong to this channel');
        return;
      }
      const rawReplyContent = reply_message.content
        .replace(/<@!?(\d+)>/g, '@user')
        .replace(/<@&(\d+)>/g, '@role')
        .replace(/<#(\d+)>/g, '#channel');
      // #38: Escape mentions in reply content to prevent ping issues
      const reply_message_content =
        rawReplyContent.length > 30 ? rawReplyContent.substring(0, 30) + '...' : rawReplyContent;

      // #39: Get proper member name for reply
      const author_name = await channel.guild.members
        .fetch(reply_message.author.id)
        .then((m) => m.displayName || m.user.username)
        .catch(() => reply_message.author.username);

      processedmessage = `> Replying to ${reply_message_content} from ${author_name}: [jump](https://discord.com/channels/${channel.guild.id}/${channel.id}/${reply_message.id})\n${processedmessage}`;

      const message = await webhook.send({
        content: processedmessage,
        username: member.displayName || member.user.tag,
        avatarURL: member.user.avatarURL() || member.user.defaultAvatarURL,
        disableEveryone: true,
      });

      bot.addToCache(message);
    }

    res.writeHead(302, { Location: `/channels/${parsedurl.searchParams.get('channel')}` });
    res.end();
  } catch (err) {
    console.error('Error sending message:', err);
    res.writeHead(302, { Location: '/server/' });
    res.end();
  }
};
