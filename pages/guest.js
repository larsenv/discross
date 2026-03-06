'use strict';

const fs = require('fs');
const escape = require('escape-html');
const { PermissionFlagsBits } = require('discord.js');

const auth = require('../authentication.js');
const notFound = require('./notFound.js');
const { buildMessagesHtml } = require('./channel.js');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const {
  strReplace,
  isValidSnowflake,
  isBotReady,
  parseCookies,
  THEME_CONFIG,
  RANDOM_EMOJIS,
} = require('./utils.js');
const { getClientIP, getTimezoneFromIP } = require('../timezoneUtils');

function loadTemplate(filePath) {
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('{$COMMON_HEAD}')
    .join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));
}

const TEMPLATE_CHANNEL = loadTemplate('pages/templates/guest_channel.html');
const TEMPLATE_NAME = loadTemplate('pages/templates/guest_name.html');
const TEMPLATE_INPUT = fs.readFileSync('pages/templates/channel/input.html', 'utf-8');
const TEMPLATE_INPUT_DISABLED = fs.readFileSync(
  'pages/templates/channel/input_disabled.html',
  'utf-8'
);

function resolveTheme(req) {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const urlTheme = parsedUrl.searchParams.get('theme');
  const cookieTheme = req.headers.cookie
    ?.split('; ')
    ?.find((c) => c.startsWith('whiteThemeCookie='))
    ?.split('=')[1];
  const themeValue =
    urlTheme !== null
      ? parseInt(urlTheme, 10)
      : cookieTheme !== undefined
        ? parseInt(cookieTheme, 10)
        : 0;
  return THEME_CONFIG[themeValue] ?? THEME_CONFIG[0];
}

// Strip non-printable / potentially dangerous characters from guest names
function sanitizeGuestName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .replace(/[^\p{L}\p{N}\p{P}\p{Z}]/gu, '')
    .trim()
    .slice(0, 32);
}

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

  let chnl;
  try {
    chnl = await bot.client.channels.fetch(channelId);
  } catch {
    chnl = undefined;
  }

  if (!chnl) {
    return notFound.serve404(req, res, 'Invalid channel.', '/', 'Back to Home');
  }

  let botMember;
  try {
    botMember = await chnl.guild.members.fetch(bot.client.user.id);
  } catch {
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
    let page = strReplace(TEMPLATE_NAME, '{$WHITE_THEME_ENABLED}', theme.themeClass);
    page = strReplace(page, '{$CHANNEL_ID}', escape(channelId));
    page = strReplace(
      page,
      '{$ERROR}',
      hasError
        ? '<font color="#f04747" face="\'rodin\', Arial, Helvetica, sans-serif">Please enter a valid name.</font>'
        : ''
    );
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

    let inputHtml = canSend
      ? strReplace(TEMPLATE_INPUT, '{$COLOR}', boxColor)
      : strReplace(TEMPLATE_INPUT_DISABLED, '{$COLOR}', boxColor);

    // Replace channel name placeholder in input template
    const channelDisplayName = (chnl.isThread() ? '' : '#') + normalizeWeirdUnicode(chnl.name);
    inputHtml = strReplace(inputHtml, '{$CHANNEL_NAME}', escape(channelDisplayName));

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
    const refreshUrl = channelId + '?random=' + Math.random();

    let page = strReplace(TEMPLATE_CHANNEL, '{$WHITE_THEME_ENABLED}', theme.themeClass);
    page = strReplace(page, '{$CHANNEL_ID}', escape(channelId));
    page = strReplace(page, '{$CHANNEL_NAME}', escape(channelDisplayName));
    page = strReplace(page, '{$GUEST_NAME}', escape(guestName));
    page = strReplace(page, '{$RANDOM_EMOJI}', randomEmoji);
    page = strReplace(page, '{$REFRESH_URL}', refreshUrl);
    page = strReplace(page, '{$INPUT}', inputHtml);
    page = strReplace(page, '{$MESSAGES}', messagesHtml);

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end('An error occurred! Please try again later.');
  }
};
