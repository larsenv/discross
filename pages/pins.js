'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { buildMessagesHtml } = require('./channel');
const { getClientIP, getTimezoneFromIP } = require('../src/timezoneUtils');
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
    const clientTimezone = getTimezoneFromIP(req);

    if (!isBotReady(bot)) {
        res.writeHead(503, { 'Content-Type': 'text/html' });
        res.end(getTemplate('bot-not-connected', 'misc'));
        return;
    }

    const chnl = await bot.client.channels.fetch(args[2]).catch(() => undefined);

    if (!chnl) {
        return notFound.serve404(req, res, 'Invalid channel.', '/', 'Back to Home');
    }

    try {
        const botMember = await chnl.guild.members.fetch(bot.client.user.id).catch(() => null);
        if (!botMember) {
            res.end(getTemplate('not-in-server', 'misc'));
            return;
        }

        const member = await chnl.guild.members.fetch(discordID).catch(() => null);
        if (!member) {
            res.end(getTemplate('join-server-to-view', 'misc'));
            return;
        }

        const canView = await require('./utils.js').canViewChannel(member, botMember, chnl);
        if (!canView) {
            res.writeHead(403, { 'Content-Type': 'text/html' });
            res.end(getTemplate('no-permission', 'misc'));
            return;
        }

        // Fetch pinned messages; fetchPins returns a paginated response with newest-pinned-first
        const pinnedResponse = await chnl.messages.fetchPins();
        const pinnedMessages = pinnedResponse.items.map((pin) => pin.message);

        const messagesHtml =
            pinnedMessages.length === 0
                ? getTemplate('no-pinned-messages', 'message')
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
        if ((err.message || err).toString().includes('error reading from remote stream')) {
            res.end(getTemplate('proxy-timeout-error', 'misc'));
        } else {
            res.end(getTemplate('generic-error', 'misc'));
        }
    }
};
