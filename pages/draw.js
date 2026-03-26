'use strict';
const fs = require('fs');
const { PermissionFlagsBits } = require('discord.js');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const notFound = require('./notFound.js');
const {
  renderTemplate,
  parseCookies,
  resolveTheme,
  buildSessionParam,
  loadAndRenderPageTemplate,
  getTemplate,
} = require('./utils.js');
const channel_template = loadAndRenderPageTemplate('draw');

exports.processDraw = async function processDraw(bot, req, res, args, discordID) {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
  const urlTheme = parsedUrl.searchParams.get('theme');
  const urlImages = parsedUrl.searchParams.get('images');

  const { whiteThemeCookie, images: imagesCookieForParam } = parseCookies(req);

  // Build combined URL params for links — only include preference params when the
  // corresponding cookie is absent (i.e. the browser doesn't support cookies)
  const sessionParam = buildSessionParam(
    urlSessionID,
    urlTheme,
    whiteThemeCookie,
    urlImages,
    imagesCookieForParam
  );

  const { boxColor, themeClass } = resolveTheme(req);
  const baseTemplate = renderTemplate(channel_template, {
    WHITE_THEME_ENABLED: themeClass,
    COLOR: boxColor,
  });
  try {
    const chnl = await bot.client.channels.fetch(args[2]).catch(() => undefined);

    if (chnl) {
      const botMember = await chnl.guild.members.fetch(bot.client.user.id);
      const member = await chnl.guild.members.fetch(discordID);

      if (
        !member.permissionsIn(chnl).has(PermissionFlagsBits.ViewChannel, true) ||
        !botMember.permissionsIn(chnl).has(PermissionFlagsBits.ViewChannel, true)
      ) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end("You (or the bot) don't have permission to do that!");
        return;
      }

      const finalTemplate = renderTemplate(baseTemplate, {
        SERVER_ID: chnl.guild.id,
        CHANNEL_ID: chnl.id,
        CHANNEL_NAME: (chnl.isThread() ? '' : '#') + normalizeWeirdUnicode(chnl.name),
        SESSION_ID: urlSessionID,
        SESSION_PARAM: sessionParam,
      });
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(finalTemplate);
    } else {
      return notFound.serve404(req, res, 'Invalid channel.', '/', 'Back to Home');
    }
  } catch (error) {
    console.error(error);
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(getTemplate('generic_error', 'misc'));
  }
};
