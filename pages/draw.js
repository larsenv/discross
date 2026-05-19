'use strict';
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
    generateSEOMetadata,
} = require('./utils.js');
const channel_template = loadAndRenderPageTemplate('draw');

exports.processDraw = async function processDraw(bot, req, res, args, discordID) {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
    const urlTheme = parsedUrl.searchParams.get('theme');
    const urlImages = parsedUrl.searchParams.get('images');
    const urlEmoji = parsedUrl.searchParams.get('emoji');
    const urlExpanded = parsedUrl.searchParams.get('expanded');
    const querySkinTone = parsedUrl.searchParams.get('skinTone');

    const { whiteThemeCookie, images: imagesCookieForParam, skinTone: cookieSkinTone } = parseCookies(req);
    const skinTone = querySkinTone !== null ? querySkinTone : cookieSkinTone || '';

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

            const canView = await require('./utils.js').canViewChannel(member, botMember, chnl);
            if (!canView) {
                res.writeHead(403, { 'Content-Type': 'text/html' });
                res.end(getTemplate('draw-permission-error', 'misc'));
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

            const { getQuickEmojiHTML, getExpandedEmojiHTML } = require('./emojiUtils');
            const isLegacy = require('./userAgentUtils.js').isLegacyClient(req.headers['user-agent']);

            const emojiPickerHTML = render(
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
                        urlEmoji === '1',
                        urlExpanded === '1',
                        sessionParam
                    ),
                    EMOJI_QUICK_HTML: getQuickEmojiHTML(skinTone),
                    EMOJI_EXPANDED_HTML: urlExpanded === '1' ? getExpandedEmojiHTML(skinTone, serverEmojis) : '',
                    EMOJI_DISPLAY: urlEmoji === '1' ? '' : 'display: none;',
                }
            );

            const channelName = (chnl.isThread() ? '' : '#') + normalizeWeirdUnicode(chnl.name);
            const pageTitle = `Draw in ${channelName} - Discross`;
            const seoDescription = `Draw and send sketches to ${channelName} on Discross, the universal Discord client.`;

            const finalTemplate = renderTemplate(baseTemplate, {
                SERVER_ID: chnl.guild.id,
                CHANNEL_ID: chnl.id,
                CHANNEL_NAME: channelName,
                SESSION_ID: urlSessionID,
                SESSION_PARAM: sessionParam,
                EMOJI_PICKER: emojiPickerHTML,
                EMOJI_BUTTON: getTemplate('emoji-picker-button', 'partials'),
                RANDOM_EMOJI: RANDOM_EMOJIS[Math.floor(Math.random() * RANDOM_EMOJIS.length)],
                EMOJI_TOGGLE_URL: buildEmojiToggleUrl(chnl.id, urlEmoji === '1', sessionParam),
                PAGE_TITLE: pageTitle,
                SEO_METADATA: generateSEOMetadata(req, {
                    title: pageTitle,
                    description: seoDescription,
                }),
            });
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(finalTemplate);
        } else {
            return notFound.serve404(req, res, 'Invalid channel.', '/', 'Back to Home');
        }
    } catch (error) {
        console.error(error);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        if ((err.message || err).toString().includes('error reading from remote stream')) {
            res.end(getTemplate('proxy-timeout-error', 'misc'));
        } else {
            res.end(getTemplate('generic-error', 'misc'));
        }
    }
};
