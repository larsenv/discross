'use strict';
const fs = require('fs');
const { PermissionFlagsBits } = require('discord.js');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const notFound = require('./notFound.js');
const { strReplace, resolveTheme, buildSessionParam } = require('./utils.js');
const channel_template = fs
  .readFileSync('pages/templates/draw.html', 'utf-8')
  .split('{$COMMON_HEAD}')
  .join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));

exports.processDraw = async function processDraw(bot, req, res, args, discordID) {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
  const urlTheme = parsedUrl.searchParams.get('theme');
  const urlImages = parsedUrl.searchParams.get('images');

  const whiteThemeCookie = req.headers.cookie
    ?.split('; ')
    ?.find((cookie) => cookie.startsWith('whiteThemeCookie='))
    ?.split('=')[1];
  const imagesCookieForParam = req.headers.cookie
    ?.split('; ')
    ?.find((cookie) => cookie.startsWith('images='))
    ?.split('=')[1];

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
  const template = strReplace(
    strReplace(channel_template, '{$WHITE_THEME_ENABLED}', themeClass),
    '{$COLOR}',
    boxColor
  );

  try {
    let chnl;
    let botMember;
    let member;
    try {
      chnl = await bot.client.channels.fetch(args[2]);
    } catch (err) {
      chnl = undefined;
    }

    if (chnl) {
      botMember = await chnl.guild.members.fetch(bot.client.user.id);
      member = await chnl.guild.members.fetch(discordID);

      if (
        !member.permissionsIn(chnl).has(PermissionFlagsBits.ViewChannel, true) ||
        !botMember.permissionsIn(chnl).has(PermissionFlagsBits.ViewChannel, true)
      ) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end("You (or the bot) don't have permission to do that!");
        return;
      }

      template = strReplace(template, '{$SERVER_ID}', chnl.guild.id);
      template = strReplace(template, '{$CHANNEL_ID}', chnl.id);
      template = strReplace(
        template,
        '{$CHANNEL_NAME}',
        (chnl.isThread() ? '' : '#') + normalizeWeirdUnicode(chnl.name)
      );
      template = strReplace(template, '{$SESSION_ID}', urlSessionID);
      template = strReplace(template, '{$SESSION_PARAM}', sessionParam);

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(template);
    } else {
      return notFound.serve404(req, res, 'Invalid channel.', '/', 'Back to Home');
    }
  } catch (error) {
    console.error(error);
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end('An error occurred! Please try again later.<br>');
  }
};
