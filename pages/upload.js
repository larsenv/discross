'use strict';
const escape = require('escape-html');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const {
    renderTemplate,
    isValidSnowflake,
    isBotReady,
    getPageThemeAttr,
    loadAndRenderPageTemplate,
} = require('./utils.js');

const upload_template = loadAndRenderPageTemplate('upload');

exports.processUpload = async function processUpload(bot, req, res, args, discordID) {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const channelId =
        (args && args.length > 2 && args[2]) || parsedUrl.searchParams.get('channel') || '';
    const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';

    if (!isValidSnowflake(channelId)) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(getTemplate('invalid_channel', 'misc'));
        return;
    }

    const channelName = isBotReady(bot)
        ? await bot.client.channels
              .fetch(channelId)
              .then((chnl) => (chnl?.name ? normalizeWeirdUnicode(chnl.name) : channelId))
              .catch(() => channelId)
        : channelId;

    const sessionParam = urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '';

    const final = renderTemplate(upload_template, {
        WHITE_THEME_ENABLED: getPageThemeAttr(req),
        CHANNEL_ID: escape(channelId),
        CHANNEL_NAME: escape(channelName),
        SESSION_ID: escape(urlSessionID),
        SESSION_PARAM: sessionParam,
    });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(final);
};
