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

exports.processUpload = async function processUpload(bot, req, res, discordID) {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const channelId = parsedUrl.searchParams.get('channel') || '';
  const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';

  if (!isValidSnowflake(channelId)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid channel ID');
    return;
  }

  let channelName = channelId;
  try {
    if (isBotReady(bot)) {
      const chnl = await bot.client.channels.fetch(channelId);
      if (chnl && chnl.name) channelName = normalizeWeirdUnicode(chnl.name);
    }
  } catch (err) {
    // Use channel ID as fallback name
  }

  const sessionParam = urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '';

  const template = strReplace(upload_template, '{$WHITE_THEME_ENABLED}', getPageThemeAttr(req));

  let final = strReplace(template, '{$CHANNEL_ID}', escape(channelId));
  final = strReplace(final, '{$CHANNEL_NAME}', escape(channelName));
  final = strReplace(final, '{$SESSION_ID}', escape(urlSessionID));
  final = strReplace(final, '{$SESSION_PARAM}', sessionParam);

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(final);
};
