'use strict';

const fs = require('fs');
const { PermissionFlagsBits } = require('discord.js');
const { buildMessagesHtml } = require('./channel');
const { getClientIP, getTimezoneFromIP } = require('../timezoneUtils');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const notFound = require('./notFound.js');
const {
  renderTemplate,
  isBotReady,
  parseCookies,
  resolveTheme,
  buildSessionParam,
  loadAndRenderPageTemplate,
  getTemplate,
} = require('./utils.js');

const channel_template = loadAndRenderPageTemplate('pins');

exports.processPins = async function processPins(bot, req, res, args, discordID) {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const urlSessionID = parsedUrl.searchParams.get('sessionID') ?? '';
  const urlTheme = parsedUrl.searchParams.get('theme');
  const urlImages = parsedUrl.searchParams.get('images');

  const { whiteThemeCookie, images: imagesCookieValue } = parseCookies(req);

  const sessionParam = buildSessionParam(
    urlSessionID,
    urlTheme,
    whiteThemeCookie,
    urlImages,
    imagesCookieValue
  );

  const theme = resolveTheme(req);
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

  const chnl = await bot.client.channels.fetch(args[2]).catch(() => undefined);

  if (!chnl) {
    return notFound.serve404(req, res, 'Invalid channel.', '/', 'Back to Home');
  }

  try {
    const botMember = await chnl.guild.members.fetch(bot.client.user.id).catch(() => null);
    if (!botMember) {
      res.end('The bot is not in this server!');
      return;
    }

    const member = await chnl.guild.members.fetch(discordID).catch(() => null);
    if (!member) {
      res.end('You are not in this server! Please join the server to view this channel.');
      return;
    }

    const canView = await require('./utils.js').canViewChannel(member, botMember, chnl);
    if (!canView) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end(
        "You (or the bot) don't have permission to do that, or this channel type is not supported."
      );
      return;
    }

    // Fetch pinned messages; fetchPins returns newest-pinned-first
    const pinnedCollection = await chnl.messages.fetchPins();
    const pinnedMessages = Array.from(pinnedCollection.values());

    const messagesHtml =
      pinnedMessages.length === 0
        ? getTemplate('no_pinned_messages', 'message')
        : await buildMessagesHtml({
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

    const final = renderTemplate(channel_template, {
      WHITE_THEME_ENABLED: theme.themeClass,
      CHANNEL_ID: chnl.id,
      SERVER_ID: chnl.guild.id,
      CHANNEL_NAME: (chnl.isThread() ? '' : '#') + normalizeWeirdUnicode(chnl.name),
      MESSAGES: messagesHtml,
      SESSION_PARAM: sessionParam,
    });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(final);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(getTemplate('generic_error', 'misc'));
  }
};
