'use strict';
const discord = require('discord.js');
const { convertEmoji } = require('./emojiConvert');
const { getOrCreateWebhook } = require('./webhookCache');
const { resolveMentions, getTemplate } = require('./utils.js');

exports.sendDrawing = async function sendDrawing(bot, req, res, args, discordID, urlQuery = null) {
  try {
    const parsedurl =
      urlQuery !== null
        ? urlQuery
        : Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);

    // Allow sending drawings with or without a message
    const channel = await bot.client.channels.fetch(parsedurl.channel);

    const member = await channel.guild.members.fetch(discordID).catch((err) => {
      console.error(`[sendDrawing] failed to fetch member:`, err);
      return null;
    });
    if (!member) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(
        'Failed to verify user permissions. Please ensure you have access to this channel or try again later.'
      );
      return;
    }

    if (!member.permissionsIn(channel).has(discord.PermissionFlagsBits.SendMessages)) {
      res.end("You don't have permission to do that!");
      return;
    }

    const webhook = await getOrCreateWebhook(channel, channel.guild.id);

    const rawMsg = convertEmoji(parsedurl.message || '');

    // Process mentions only if there's a message
    const processedmessage = rawMsg ? await resolveMentions(rawMsg, channel.guild) : rawMsg;

    const base64Data = parsedurl.drawinginput;

    // Validate that we have drawing data
    if (!base64Data || base64Data.trim() === '') {
      console.error('[sendDrawing] Error processing image: Input Buffer is empty');
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('No drawing data provided. Please draw something before sending.');
      return;
    }

    // Remove the data URL prefix
    let base64Image;
    if (base64Data.includes(';base64,')) {
      base64Image = base64Data.split(';base64,').pop();
    } else {
      base64Image = base64Data;
    }

    // Validate the base64 string is not empty
    if (!base64Image || base64Image.trim() === '') {
      console.error('[sendDrawing] Error processing image: Base64 data is empty after split');
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('Invalid drawing data format. Please try again.');
      return;
    }

    const imageBuffer = Buffer.from(base64Image, 'base64');

    // Validate the buffer is not empty
    if (!imageBuffer || imageBuffer.length === 0) {
      console.error('[sendDrawing] Error processing image: Generated buffer is empty');
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('Failed to process drawing data. Please try again.');
      return;
    }

    // Discord.js requires Buffer for attachments
    const webhookOptions = {
      username: member.displayName || member.user.tag,
      avatarURL: member.user.avatarURL() || member.user.defaultAvatarURL,
      files: [
        {
          attachment: imageBuffer,
          name: 'drawing.png',
        },
      ],
    };

    // Only add content if there's a message
    if (processedmessage && processedmessage.length > 0) {
      webhookOptions.content = processedmessage;
    }

    const message = await webhook.send(webhookOptions);
    bot.addToCache(message);

    res.writeHead(302, { Location: `/channels/${parsedurl.channel}#end` });
    res.end();
  } catch (err) {
    console.error(`[sendDrawing] Error:`, err);
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(getTemplate('generic_error', 'misc'));
  }
};
