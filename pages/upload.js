const fs = require('fs');
const escape = require('escape-html');
const { normalizeWeirdUnicode } = require('./unicodeUtils');

const head_partial = fs.readFileSync('pages/templates/partials/head.html', 'utf-8');
const upload_template = fs.readFileSync('pages/templates/upload.html', 'utf-8')
  .split('{$COMMON_HEAD}').join(head_partial);

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || "");
}

function isValidSnowflake(id) {
  return typeof id === 'string' && /^[0-9]{16,20}$/.test(id);
}

exports.processUpload = async function processUpload(bot, req, res, discordID) {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const channelId = parsedUrl.searchParams.get('channel') || '';
  const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';

  if (!isValidSnowflake(channelId)) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Invalid channel ID");
    return;
  }

  let channelName = channelId;
  try {
    const clientIsReady = bot && bot.client && (typeof bot.client.isReady === 'function' ? bot.client.isReady() : !!bot.client.uptime);
    if (clientIsReady) {
      const chnl = await bot.client.channels.fetch(channelId);
      if (chnl && chnl.name) channelName = normalizeWeirdUnicode(chnl.name);
    }
  } catch (err) {
    // Use channel ID as fallback name
  }

  const urlTheme = parsedUrl.searchParams.get('theme');
  const whiteThemeCookie = req.headers.cookie?.split('; ')?.find(c => c.startsWith('whiteThemeCookie='))?.split('=')[1];
  const theme = urlTheme !== null ? parseInt(urlTheme) : (whiteThemeCookie !== undefined ? parseInt(whiteThemeCookie) : 0);

  const sessionParam = urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '';

  let template = upload_template;
  if (theme === 1) {
    template = strReplace(template, "{$WHITE_THEME_ENABLED}", "class=\"light-theme\"");
  } else if (theme === 2) {
    template = strReplace(template, "{$WHITE_THEME_ENABLED}", "class=\"amoled-theme\"");
  } else {
    template = strReplace(template, "{$WHITE_THEME_ENABLED}", "");
  }

  let final = strReplace(template, "{$CHANNEL_ID}", escape(channelId));
  final = strReplace(final, "{$CHANNEL_NAME}", escape(channelName));
  final = strReplace(final, "{$SESSION_ID}", escape(urlSessionID));
  final = strReplace(final, "{$SESSION_PARAM}", sessionParam);

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(final);
};
