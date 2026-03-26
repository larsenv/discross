'use strict';

const fs = require('fs');
const escape = require('escape-html');
const { PermissionFlagsBits } = require('discord.js');

const auth = require('../authentication.js');
const notFound = require('./notFound.js');
const { buildMessagesHtml } = require('./channel.js');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const {
  renderTemplate,
  isValidSnowflake,
  isBotReady,
  parseCookies,
  resolveTheme,
  RANDOM_EMOJIS,
  sanitizeGuestName,
  loadAndRenderPageTemplate,
  getTemplate,
} = require('./utils.js');

const TEMPLATE_CHANNEL = loadAndRenderPageTemplate('guest_channel');
const TEMPLATE_NAME = loadAndRenderPageTemplate('guest_name');
const TEMPLATE_INPUT = fs.readFileSync('pages/templates/channel/input.html', 'utf-8');
const TEMPLATE_INPUT_DISABLED = fs.readFileSync(
  'pages/templates/channel/input_disabled.html',
  'utf-8'
);

exports.processGuestName = async function processGuestName(req, res) {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const channelId = parsedUrl.searchParams.get('channel');
  const rawName = parsedUrl.searchParams.get('name') || '';
  const name = sanitizeGuestName(rawName);

  if (!isValidSnowflake(channelId) || !auth.isGuestChannel(channelId)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Guest access is not enabled for this channel.');
    return;
  }

  if (!name) {
    res.writeHead(302, { Location: `/channels/${channelId}?guest_name_error=1` });
    res.end();
    return;
  }

  res.writeHead(302, {
    Location: `/channels/${channelId}`,
    'Set-Cookie': `guest_name=${encodeURIComponent(name)}; path=/; HttpOnly`,
  });
  res.end();
};

exports.processGuestChannel = async function processGuestChannel(bot, req, res, channelId) {
  const theme = resolveTheme(req);

  if (!isBotReady(bot)) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end("The bot isn't connected, try again in a moment");
    return;
  }

  const chnl = await bot.client.channels.fetch(channelId).catch(() => undefined);

  if (!chnl) {
    return notFound.serve404(req, res, 'Invalid channel.', '/', 'Back to Home');
  }

  const botMember = await chnl.guild.members.fetch(bot.client.user.id).catch(() => null);
  if (!botMember) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('The bot is not in this server!');
    return;
  }

  const canView = botMember.permissionsIn(chnl).has(PermissionFlagsBits.ViewChannel, true);
  if (!canView) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end("The bot doesn't have permission to view this channel.");
    return;
  }

  const parsedUrl = new URL(req.url, 'http://localhost');
  const cookies = parseCookies(req);
  const guestName = cookies.guest_name;

  // Show name entry page if no guest name set
  if (!guestName) {
    const hasError = parsedUrl.searchParams.get('guest_name_error') === '1';
    const page = renderTemplate(TEMPLATE_NAME, {
      WHITE_THEME_ENABLED: theme.themeClass,
      CHANNEL_ID: escape(channelId),
      ERROR: hasError ? getTemplate('invalid_name_error', 'misc') : '',
    });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page);
    return;
  }

  // Render channel for guest
  try {
    const imagesCookie = (() => {
      const urlImages = parsedUrl.searchParams.get('images');
      const cookieImages = cookies.images;
      return urlImages !== null
        ? parseInt(urlImages, 10)
        : cookieImages !== undefined
          ? parseInt(cookieImages, 10)
          : 1;
    })();

    const clientTimezone = getTimezoneFromIP(getClientIP(req));
    const { boxColor, authorText, replyText } = theme;
    const canSend =
      botMember.permissionsIn(chnl).has(PermissionFlagsBits.ManageWebhooks, true) &&
      botMember.permissionsIn(chnl).has(PermissionFlagsBits.SendMessages, true);

    const channelDisplayName = (chnl.isThread() ? '' : '#') + normalizeWeirdUnicode(chnl.name);
    const inputTemplate = canSend ? TEMPLATE_INPUT : TEMPLATE_INPUT_DISABLED;
    const inputHtml = renderTemplate(inputTemplate, {
      COLOR: boxColor,
      CHANNEL_NAME: escape(channelDisplayName),
    });
    const messagesHtml = await buildMessagesHtml({
      bot,
      chnl,
      member: botMember,
      discordID: bot.client.user.id,
      req,
      imagesCookie,
      animationsCookie: 1,
      authorText,
      replyText,
      clientTimezone,
      channelId,
    });

    const randomEmoji = RANDOM_EMOJIS[Math.floor(Math.random() * RANDOM_EMOJIS.length)];
    const refreshUrl = `${channelId}?random=${Math.random()}`;

    const page = renderTemplate(TEMPLATE_CHANNEL, {
      WHITE_THEME_ENABLED: theme.themeClass,
      CHANNEL_ID: escape(channelId),
      CHANNEL_NAME: escape(channelDisplayName),
      GUEST_NAME: escape(guestName),
      RANDOM_EMOJI: randomEmoji,
      REFRESH_URL: refreshUrl,
      INPUT: inputHtml,
      MESSAGES: messagesHtml,
    });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(getTemplate('generic_error', 'misc'));
  }
};
