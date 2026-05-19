'use strict';

const escape = require('escape-html');
const { PermissionFlagsBits } = require('discord.js');
const notFound = require('./notFound.js');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const {
    isBotReady,
    parseCookies,
    resolveTheme,
    RANDOM_EMOJIS,
    buildSessionParam,
    buildEmojiToggleUrl,
    buildEmojiExpandUrl,
    getTemplate,
    renderTemplate,
    render,
    generateSEOMetadata,
    canViewChannel,
} = require('./utils.js');
const { getTimezoneFromIP } = require('../src/timezoneUtils');
const { isLegacyClient } = require('./userAgentUtils.js');
const { buildMessagesHtml } = require('./messageRenderer.js');

exports.processChannel = async function processChannel(bot, req, res, args, discordID) {
    const parsedUrl = new URL(req.url, 'http://localhost');

    const urlSessionID = parsedUrl.searchParams.get('sessionID') ?? '',
        urlTheme = parsedUrl.searchParams.get('theme'),
        urlImages = parsedUrl.searchParams.get('images'),
        urlEmoji = parsedUrl.searchParams.get('emoji'),
        urlExpanded = parsedUrl.searchParams.get('expanded');

    const { images: cookieImages, whiteThemeCookie: cookieTheme } = parseCookies(req);

    const imagesCookie =
        urlImages !== null
            ? parseInt(urlImages, 10)
            : cookieImages !== undefined
              ? parseInt(cookieImages, 10)
              : 1;

    const theme = resolveTheme(req),
        { authorText, replyText, boxColor, barColor } = theme;

    if (!isBotReady(bot)) {
        res.writeHead(503, { 'Content-Type': 'text/html' });
        res.end(getTemplate('bot-not-connected', 'misc'));
        return;
    }

    const clientTimezone = getTimezoneFromIP(req),
        chnl = await bot.client.channels.fetch(args[2]).catch(() => undefined);

    if (!chnl) return notFound.serve404(req, res, 'Invalid channel.', '/', 'Back to Home');

    // Handle Skin Tone
    const { emojiSkinTone: cookieSkinTone } = parseCookies(req);
    const querySkinTone = parsedUrl.searchParams.get('skinTone');
    const skinTone = querySkinTone !== null ? querySkinTone : cookieSkinTone || '';

    if (querySkinTone !== null) {
        res.setHeader('Set-Cookie', `emojiSkinTone=${querySkinTone}; Path=/; Max-Age=31536000`);
    }

    const sessionParam = buildSessionParam(
        urlSessionID,
        urlTheme,
        cookieTheme,
        urlImages,
        cookieImages,
        querySkinTone,
        cookieSkinTone
    );

    try {
        const botMember = await chnl.guild.members.fetch(bot.client.user.id).catch(() => null);

        if (!botMember) {
            res.writeHead(503, { 'Content-Type': 'text/html' });
            res.end(getTemplate('not-in-server', 'misc'));
            return;
        }

        const member = await chnl.guild.members.fetch(discordID).catch(() => null);

        if (!member) {
            res.writeHead(403, { 'Content-Type': 'text/html' });
            res.end(getTemplate('join-server-to-view', 'misc'));
            return;
        }

        const canView = await canViewChannel(member, botMember, chnl);

        if (!canView) {
            res.writeHead(403, { 'Content-Type': 'text/html' });
            res.end(getTemplate('no-permission', 'misc'));
            return;
        }

        // Fetch server emojis
        let serverEmojis = [];
        let serverEmojisJSON = '[]';
        if (chnl.guild && chnl.guild.emojis && chnl.guild.emojis.cache) {
            serverEmojis = chnl.guild.emojis.cache.map((e) => ({
                id: e.id,
                name: e.name,
                animated: e.animated,
                url: e.imageURL(),
            }));
            serverEmojisJSON = JSON.stringify(serverEmojis);
        }

        const { getQuickEmojiHTML, getExpandedEmojiHTML, getSkinToneSelectorHTML } = require('./emojiUtils');
        const isLegacy = isLegacyClient(req.headers['user-agent']);

        const baseTemplate = render('/channel', {
            COMMON_HEAD: getTemplate('head', 'partials'),
            PAGE_CLASS: 'page-channel',
            EMOJI_PICKER: render(
                isLegacy ? 'partials/emoji-picker-lite' : 'partials/emoji-picker',
                {
                    SERVER_EMOJIS_JSON: serverEmojisJSON,
                    SKINTONE_SELECTOR_HTML: getSkinToneSelectorHTML(
                        chnl.id,
                        urlEmoji === '1',
                        urlExpanded === '1',
                        sessionParam
                    ),
                    SKIN_TONE: skinTone,
                    EMOJI_OPEN: urlExpanded === '1' ? 'open' : '',
                    EMOJI_EXPAND_URL: buildEmojiExpandUrl(
                        chnl.id,
                        urlExpanded === '1',
                        sessionParam
                    ),
                    EMOJI_QUICK_HTML: getQuickEmojiHTML(skinTone),
                    EMOJI_EXPANDED_HTML:
                        urlExpanded === '1' ? getExpandedEmojiHTML(skinTone, serverEmojis) : '',
                }
            ),
            EMOJI_BUTTON: getTemplate('emoji-picker-button', 'partials'),
            CHANNEL_REPLY: '',
            REPLY_MESSAGE_ID_INPUT: '',
            WHITE_THEME_ENABLED: theme.themeClass,
            SERVER_ID: chnl.guild.id,
            CHANNEL_ID: chnl.id,
        });

        const inputHtml = !botMember
            .permissionsIn(chnl)
            .has(PermissionFlagsBits.ManageWebhooks, true)
            ? render('channel/input-disabled', {
                  COLOR: boxColor,
                  "You don't have permission to send messages in this channel.":
                      "Discross bot doesn't have the Manage Webhooks permission",
              })
            : member.permissionsIn(chnl).has(PermissionFlagsBits.SendMessages, true)
              ? render('channel/input', { COLOR: boxColor })
              : render('channel/input-disabled', { COLOR: boxColor });

        const channelDisplayName = (chnl.isThread() ? '' : '#') + normalizeWeirdUnicode(chnl.name);
        const serverName = chnl.guild.name;
        const normalizedServerName = normalizeWeirdUnicode(serverName);
        const pageTitle = `${channelDisplayName} - ${normalizedServerName}${normalizedServerName.toLowerCase() === 'discross' ? '' : ' - Discross'}`;
        const seoDescription = `Chat in ${channelDisplayName} on ${normalizedServerName} using Discross, the universal Discord client.`;
        const seoMetadata = generateSEOMetadata(req, {
            title: pageTitle,
            description: seoDescription,
        });

        if (!member.permissionsIn(chnl).has(PermissionFlagsBits.ReadMessageHistory, true)) {
            const final = renderTemplate(baseTemplate, {
                INPUT: inputHtml,
                MESSAGES: getTemplate('no-message-history', 'channel'),
                CHANNEL_NAME: escape(channelDisplayName),
                SESSION_ID: urlSessionID,
                SESSION_PARAM: sessionParam,
                EMOJI_DISPLAY: urlEmoji === '1' ? '' : 'display: none;',
                EMOJI_TOGGLE_URL: buildEmojiToggleUrl(chnl.id, urlEmoji === '1', sessionParam),
                PAGE_TITLE: pageTitle,
                SEO_METADATA: seoMetadata,
            });
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(final);
            return;
        }

        const messagesHtml = await exports.buildMessagesHtml({
            bot,
            chnl,
            member,
            discordID,
            req,
            imagesCookie,
            animationsCookie: 1,
            authorText,
            replyText,
            barColor,
            clientTimezone,
            channelId: args[2],
        });

        const refreshUrl =
            chnl.id +
            '?random=' +
            Math.random() +
            (urlSessionID ? '&sessionID=' + encodeURIComponent(urlSessionID) : '');

        const final = renderTemplate(baseTemplate, {
            REFRESH_URL: refreshUrl,
            INPUT: inputHtml,
            RANDOM_EMOJI: RANDOM_EMOJIS[Math.floor(Math.random() * RANDOM_EMOJIS.length)],
            CHANNEL_NAME: escape(channelDisplayName),
            MESSAGES: messagesHtml,
            SESSION_ID: urlSessionID,
            SESSION_PARAM: sessionParam,
            EMOJI_DISPLAY: urlEmoji === '1' ? '' : 'display: none;',
            EMOJI_TOGGLE_URL: buildEmojiToggleUrl(chnl.id, urlEmoji === '1', sessionParam),
            PAGE_TITLE: pageTitle,
            SEO_METADATA: seoMetadata,
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