'use strict';
const fs = require('fs');
const escape = require('escape-html');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const { strReplace, isValidSnowflake, isBotReady, getPageThemeAttr } = require('./utils.js');

const head_partial = fs.readFileSync('pages/templates/partials/head.html', 'utf-8');
const upload_template = fs
  .readFileSync('pages/templates/upload.html', 'utf-8')
  .split('{$COMMON_HEAD}')
  .join(head_partial);

exports.processUpload = async function processUpload(bot, req, res, args, discordID) {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const channelId = (args && args.length > 2 && args[2]) || parsedUrl.searchParams.get('channel') || '';
  const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';

  if (!isValidSnowflake(channelId)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid channel ID');
    return;
  }

  const channelName = isBotReady(bot)
    ? await bot.client.channels
        .fetch(channelId)
        .then((chnl) => (chnl?.name ? normalizeWeirdUnicode(chnl.name) : channelId))
        .catch(() => channelId)
    : channelId;

  const sessionParam = urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '';

  const template = strReplace(upload_template, '{$WHITE_THEME_ENABLED}', getPageThemeAttr(req));

  const withChannelId = strReplace(template, '{$CHANNEL_ID}', escape(channelId));
  const withChannelName = strReplace(withChannelId, '{$CHANNEL_NAME}', escape(channelName));
  const withSessionId = strReplace(withChannelName, '{$SESSION_ID}', escape(urlSessionID));
  const final = strReplace(withSessionId, '{$SESSION_PARAM}', sessionParam);

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(final);
};
