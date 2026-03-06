'use strict';
const discord = require('discord.js');
const { convertEmoji } = require('./emojiConvert');
const { getOrCreateWebhook } = require('./webhookCache');
const { strReplace } = require('./utils.js');

exports.sendDrawing = async function sendDrawing(bot, req, res, args, discordID, urlQuery = null) {
  try {
    let parsedurl;
    if (urlQuery === null) {
      parsedurl = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    } else {
      parsedurl = urlQuery;
    }

    // Allow sending drawings with or without a message
    const channel = await bot.client.channels.fetch(parsedurl.channel);

    let member;
    try {
      member = await channel.guild.members.fetch(discordID);
    } catch (err) {
      console.error(`[sendDrawing] failed to fetch member:`, err);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.write(
        'Failed to verify user permissions. Please ensure you have access to this channel or try again later.'
      );
      res.end();
      return;
    }

    if (!member.permissionsIn(channel).has(discord.PermissionFlagsBits.SendMessages)) {
      res.write("You don't have permission to do that!");
      res.end();
      return;
    }

    const webhook = await getOrCreateWebhook(channel, channel.guild.id);

    let processedmessage = convertEmoji(parsedurl.message || '');

    // Process mentions only if there's a message
    if (processedmessage) {
      const regex = /@([^#]{2,32}#\d{4})/g;
      let m;
      do {
        m = regex.exec(processedmessage);
        if (m) {
          let mentioneduser = channel.guild.members.cache.find(
            (member) => member.user.tag === m[1]
          );
          if (!mentioneduser) {
            try {
              mentioneduser = (await channel.guild.members.fetch()).find(
                (member) => member.user.tag === m[1]
              );
            } catch (err) {
              console.error('Failed to fetch members for mention:', err);
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
      console.error('[sendDrawing] Error processing image: Input Buffer is empty');
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.write('No drawing data provided. Please draw something before sending.');
      res.end();
      return;
    }

    // Remove the data URL prefix
    const base64Image = base64Data.split(';base64,').pop();

    // Validate the base64 string is not empty
    if (!base64Image || base64Image.trim() === '') {
      console.error('[sendDrawing] Error processing image: Base64 data is empty after split');
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.write('Invalid drawing data format. Please try again.');
      res.end();
      return;
    }

    const imageBuffer = Buffer.from(base64Image, 'base64');

    // Validate the buffer is not empty
    if (!imageBuffer || imageBuffer.length === 0) {
      console.error('[sendDrawing] Error processing image: Generated buffer is empty');
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.write('Failed to process drawing data. Please try again.');
      res.end();
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
    res.write('An error occurred! Please try again later.<br>');
    res.end();
  }
};
