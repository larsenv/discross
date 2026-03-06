'use strict';

const auth = require('../authentication.js');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const { convertEmoji } = require('./emojiConvert');
const { getOrCreateWebhook } = require('./webhookCache');
const {
  isValidSnowflake,
  isBotReady,
  parseCookies,
  getBaseUrl,
  sanitizeGuestName,
} = require('./utils.js');

exports.guestSend = async function guestSend(bot, req, res) {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const channelId = parsedUrl.searchParams.get('channel');
  const rawMessage = parsedUrl.searchParams.get('message') || '';
  const cookies = parseCookies(req);
  const rawName = parsedUrl.searchParams.get('guest_name') || cookies.guest_name || '';
  const guestName = sanitizeGuestName(rawName);

  const baseUrl = getBaseUrl(req);

  // Validate channel id
  if (!isValidSnowflake(channelId)) {
    res.writeHead(302, { Location: baseUrl + '/' });
    res.end();
    return;
  }

  // Check guest mode is enabled for this channel
  if (!auth.isGuestChannel(channelId)) {
    res.writeHead(302, { Location: baseUrl + '/' });
    res.end();
    return;
  }

  // Validate guest name
  if (!guestName) {
    res.writeHead(302, { Location: baseUrl + '/channels/' + channelId });
    res.end();
    return;
  }

  // Check bot is ready
  if (!isBotReady(bot)) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end("The bot isn't connected, try again in a moment");
    return;
  }

  // Fetch channel
  const channel = await bot.client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    res.writeHead(302, { Location: baseUrl + '/' });
    res.end();
    return;
  }

  // Only send non-empty messages
  if (typeof rawMessage === 'string' && rawMessage.trim() !== '') {
    const processedMessage = convertEmoji(rawMessage);
    const webhook = await getOrCreateWebhook(channel, channel.guild.id);

    // Use the bot's avatar as the guest profile picture
    const avatarURL = bot.client.user.displayAvatarURL({ extension: 'png', size: 128 });

    const sendOptions = {
      content: processedMessage,
      username: normalizeWeirdUnicode(guestName) + ' (guest)',
      avatarURL: avatarURL,
      disableEveryone: true,
    };
    if (channel.isThread()) {
      sendOptions.threadId = channel.id;
    }
    const message = await webhook.send(sendOptions);
    bot.addToCache(message);
  }

  res.writeHead(302, { Location: baseUrl + '/channels/' + channelId });
  res.end();
};
