'use strict';

const fs = require('fs');
const { PermissionFlagsBits } = require('discord.js');
const { buildMessagesHtml } = require('./channel');
const { getClientIP, getTimezoneFromIP } = require('../timezoneUtils');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const notFound = require('./notFound.js');
const { strReplace, isBotReady, THEME_CONFIG, buildSessionParam } = require('./utils.js');

const channel_template = fs
  .readFileSync('pages/templates/pins.html', 'utf-8')
  .split('{$COMMON_HEAD}')
  .join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));

exports.processPins = async function processPins(bot, req, res, args, discordID) {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const urlSessionID = parsedUrl.searchParams.get('sessionID') ?? '';
  const urlTheme = parsedUrl.searchParams.get('theme');
  const urlImages = parsedUrl.searchParams.get('images');

  const whiteThemeCookie = req.headers.cookie
    ?.split('; ')
    ?.find((c) => c.startsWith('whiteThemeCookie='))
    ?.split('=')[1];
  const imagesCookieValue = req.headers.cookie
    ?.split('; ')
    ?.find((c) => c.startsWith('images='))
    ?.split('=')[1];

  const sessionParam = buildSessionParam(
    urlSessionID,
    urlTheme,
    whiteThemeCookie,
    urlImages,
    imagesCookieValue
  );

  const themeValue =
    urlTheme !== null
      ? parseInt(urlTheme, 10)
      : whiteThemeCookie !== undefined
        ? parseInt(whiteThemeCookie, 10)
        : 0;
  const theme = THEME_CONFIG[themeValue] ?? THEME_CONFIG[0];
  const { authorText, replyText } = theme;

  const imagesCookie =
    urlImages !== null
      ? parseInt(urlImages, 10)
      : imagesCookieValue !== undefined
        ? parseInt(imagesCookieValue, 10)
        : 1;
  const clientTimezone = getTimezoneFromIP(getClientIP(req));

  if (!isBotReady(bot)) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end("The bot isn't connected, try again in a moment");
    return;
  }

  let chnl;
  try {
    chnl = await bot.client.channels.fetch(args[2]);
  } catch {
    chnl = undefined;
  }

  if (!chnl) {
    return notFound.serve404(req, res, 'Invalid channel.', '/', 'Back to Home');
  }

  try {
    let botMember, member;
    try {
      botMember = await chnl.guild.members.fetch(bot.client.user.id);
    } catch {
      res.end('The bot is not in this server!');
      return;
    }

    try {
      member = await chnl.guild.members.fetch(discordID);
    } catch {
      res.end('You are not in this server! Please join the server to view this channel.');
      return;
    }

    const canView =
      member.permissionsIn(chnl).has(PermissionFlagsBits.ViewChannel, true) &&
      botMember.permissionsIn(chnl).has(PermissionFlagsBits.ViewChannel, true);
    if (!canView) {
      res.end("You (or the bot) don't have permission to do that!");
      return;
    }

    // Fetch pinned messages; fetchPinned returns newest-pinned-first
    const pinnedCollection = await chnl.messages.fetchPinned();
    const pinnedMessages = Array.from(pinnedCollection.values());

    let messagesHtml;
    if (pinnedMessages.length === 0) {
      messagesHtml =
        '<p style="color: #72767d; font-family: \'rodin\', Arial, Helvetica, sans-serif;">No pinned messages in this channel.</p>';
    } else {
      messagesHtml = await buildMessagesHtml({
        bot,
        chnl,
        member,
        discordID,
        req,
        imagesCookie,
        animationsCookie: 1,
        authorText,
        replyText,
        clientTimezone,
        channelId: null,
        messages: pinnedMessages,
      });
    }

    let final = strReplace(channel_template, '{$WHITE_THEME_ENABLED}', theme.themeClass);
    final = strReplace(final, '{$CHANNEL_ID}', chnl.id);
    final = strReplace(final, '{$SERVER_ID}', chnl.guild.id);
    final = strReplace(
      final,
      '{$CHANNEL_NAME}',
      (chnl.isThread() ? '' : '#') + normalizeWeirdUnicode(chnl.name)
    );
    final = strReplace(final, '{$MESSAGES}', messagesHtml);
    final = strReplace(final, '{$SESSION_PARAM}', sessionParam);

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(final);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end('An error occurred! Please try again later.');
  }
};
