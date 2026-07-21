'use strict';
const fs = require('fs');
const { PermissionFlagsBits } = require('discord');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const notFound = require('./notFound');
const {
    renderTemplate,
    render,
    parseCookies,
    resolveTheme,
    buildSessionParam,
    loadAndRenderPageTemplate,
    getTemplate,
    generateSEOMetadata,
    RANDOM_EMOJIS,
    buildEmojiToggleUrl,
    buildEmojiExpandUrl,
} = require('./utils');
const channel_template = loadAndRenderPageTemplate('draw');
const old3ds_template = loadAndRenderPageTemplate('draw-old3ds');

// The Wii uses the SAME draw template as everyone else; the only differences are
// injected via tokens (see the isWii branch below): an extra <style> block of
// Opera-9 layout overrides, a fixed-form wrapper, no emoji picker, and inline
// styles on the message/Send inputs. Keeping one template avoids the two files
// silently drifting apart. draw-wii-head.html holds the Wii-only <style> block.
const WII_EXTRA_HEAD = getTemplate('draw-wii-head', 'partials');
const WII_FORM_WRAPPER_OPEN = '<div class="content-padding">';
const WII_FORM_WRAPPER_CLOSE = '</div>';
const WII_MSG_INPUT_STYLE_ATTR =
    ' style="box-sizing: border-box; width: 100%; color: #dcddde; background: transparent; border: none; outline: none; height: 40px; padding: 9px 16px; font-family: \'rodin\', Whitney, \'Helvetica Neue\', Helvetica, Arial, sans-serif; font-size: 16px; line-height: 20px;"';
const WII_SEND_BTN_STYLE_ATTR =
    ' style="-webkit-appearance: none; -moz-appearance: none; appearance: none; box-sizing: border-box; background: #5865f2; border: none; border-radius: 4px; color: white; padding: 0 16px; cursor: pointer; font-family: \'rodin\', Whitney, \'Helvetica Neue\', Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 500; height: 40px; line-height: 40px; white-space: nowrap; margin-right: 8px; display: block; width: 82px;"';

// Wii/DSi Opera 9 caches HTML pages extremely aggressively and heuristically,
// so it keeps re-serving a stale copy of the draw page no matter how many times
// the tool is edited. Force a full revalidation on every load. Pragma/Expires are
// included for the HTTP/1.0 semantics these legacy browsers actually honor.
const NO_CACHE_HTML_HEADERS = {
    'Content-Type': 'text/html',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
};

exports.processDraw = async function processDraw(bot, req, res, args, discordID) {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
    const urlTheme = parsedUrl.searchParams.get('theme');
    const urlImages = parsedUrl.searchParams.get('images');
    const urlEmoji = parsedUrl.searchParams.get('emoji');
    const urlExpanded = parsedUrl.searchParams.get('expanded');
    const querySkinTone = parsedUrl.searchParams.get('skinTone');

    const {
        whiteThemeCookie,
        images: imagesCookieForParam,
        skinTone: cookieSkinTone,
    } = parseCookies(req);
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

    // Inline draw.js into a template so Wii/DSi Opera 9 executes it AFTER the DOM is
    // parsed. An external <script src> on Wii Opera 9 can fire before the canvas and
    // toolbar elements exist, breaking getElementById and leaving the tool dead.
    const inlineDrawJs = (html) => {
        try {
            const drawJs = fs.readFileSync('pages/static/js/draw.js', 'utf-8');
            return html.replace(
                /<script src="\/js\/draw\.js[^"]*"><\/script>/,
                '<script>\n' + drawJs + '\n</script>'
            );
        } catch (ex) {
            return html;
        }
    };
    try {
        const chnl = await bot.client.channels.fetch(args[2]).catch(() => undefined);

        if (chnl) {
            const botMember = await chnl.guild.members.fetch(bot.client.user.id);
            const member = await chnl.guild.members.fetch(discordID);

            const canView = await require('./utils').canViewChannel(member, botMember, chnl);
            if (!canView) {
                res.writeHead(403, { 'Content-Type': 'text/html' });
                res.end(getTemplate('draw-permission-error', 'misc'));
                return;
            }

            const userAgentStr = req.headers['user-agent'] || '';
            const is3DS =
                userAgentStr.indexOf('Nintendo 3DS') !== -1 ||
                userAgentStr.indexOf('Nintendo DSi') !== -1;
            const isNew3DS = is3DS && userAgentStr.indexOf('NintendoBrowser') !== -1;
            const isOld3DS = is3DS && !isNew3DS;

            const isWii =
                (userAgentStr.toLowerCase().indexOf('nintendo wii') !== -1 ||
                    userAgentStr.toLowerCase().indexOf('wii') !== -1) &&
                userAgentStr.toLowerCase().indexOf('wiiu') === -1;

            const urlMode = parsedUrl.searchParams.get('mode') || '';
            const urlOld3DS = parsedUrl.searchParams.get('old3ds') || '';
            const useOld3DSMode =
                (isOld3DS || urlMode === 'old3ds' || urlMode === 'lite' || urlOld3DS === '1') &&
                urlMode !== 'standard' &&
                urlOld3DS !== '0';

            const channelName = (chnl.isThread() ? '' : '#') + normalizeWeirdUnicode(chnl.name);
            const pageTitle = `Draw in ${channelName} - Discross`;

            // Wii: same shared draw template as everyone else, but with the Wii-only
            // tokens filled — the Opera-9 <style> overrides in the head, the fixed-form
            // wrapper, no emoji picker, and inline styles on the message/Send inputs.
            // draw.js detects the Wii UA and uses immediate strokes while skipping the
            // getImageData undo history that freezes Wii Opera.
            if (isWii) {
                const wiiTemplate = renderTemplate(baseTemplate, {
                    MODE_TOGGLE_URL: sessionParam ? sessionParam + '&mode=old3ds' : '?mode=old3ds',
                    CHANNEL_ID: chnl.id,
                    CHANNEL_NAME: channelName,
                    SESSION_ID: urlSessionID,
                    SESSION_PARAM: sessionParam,
                    // Wii-only tokens (empty for every other client).
                    EXTRA_HEAD: WII_EXTRA_HEAD,
                    FORM_WRAPPER_OPEN: WII_FORM_WRAPPER_OPEN,
                    FORM_WRAPPER_CLOSE: WII_FORM_WRAPPER_CLOSE,
                    MSG_INPUT_STYLE_ATTR: WII_MSG_INPUT_STYLE_ATTR,
                    SEND_BTN_STYLE_ATTR: WII_SEND_BTN_STYLE_ATTR,
                    // The Wii layout has no emoji picker; clear the tokens so they
                    // don't render as literal "{$EMOJI_PICKER}" text on the page.
                    EMOJI_PICKER: '',
                    EMOJI_BUTTON: '',
                });
                res.writeHead(200, NO_CACHE_HTML_HEADERS);
                res.end(inlineDrawJs(wiiTemplate));
                return;
            }

            if (useOld3DSMode) {
                const modeToggleUrl = sessionParam
                    ? sessionParam + '&mode=standard'
                    : '?mode=standard';
                const final3DSTemplate = renderTemplate(old3ds_template, {
                    COMMON_HEAD: getTemplate('head', 'partials'),
                    WHITE_THEME_ENABLED: themeClass,
                    SERVER_ID: chnl.guild.id,
                    CHANNEL_ID: chnl.id,
                    CHANNEL_NAME: channelName,
                    SESSION_ID: urlSessionID,
                    SESSION_PARAM: sessionParam,
                    PAGE_TITLE: `3DS Paint (DSiPaint Engine) in ${channelName} - Discross`,
                    MODE_TOGGLE_URL: modeToggleUrl,
                });
                res.writeHead(200, NO_CACHE_HTML_HEADERS);
                res.end(final3DSTemplate);
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

            const {
                getQuickEmojiHTML,
                getExpandedEmojiHTML,
                getSkinToneSelectorHTML,
            } = require('./emojiUtils');
            const isLegacy = require('./userAgentUtils').isLegacyClient(req.headers['user-agent']);

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
                        urlExpanded === '1',
                        sessionParam
                    ),
                    EMOJI_QUICK_HTML: getQuickEmojiHTML(skinTone),
                    EMOJI_EXPANDED_HTML:
                        urlExpanded === '1' ? getExpandedEmojiHTML(skinTone, serverEmojis) : '',
                    EMOJI_DISPLAY: urlEmoji === '1' ? '' : 'display: none;',
                }
            );

            const seoDescription = `Draw and send sketches to ${channelName} on Discross, the universal Discord client.`;

            const modeToggleUrl = sessionParam ? sessionParam + '&mode=old3ds' : '?mode=old3ds';
            let finalTemplate = renderTemplate(baseTemplate, {
                SERVER_ID: chnl.guild.id,
                CHANNEL_ID: chnl.id,
                CHANNEL_NAME: channelName,
                SESSION_ID: urlSessionID,
                SESSION_PARAM: sessionParam,
                EMOJI_PICKER: emojiPickerHTML,
                EMOJI_BUTTON: getTemplate('emoji-picker-button', 'partials'),
                RANDOM_EMOJI: RANDOM_EMOJIS[Math.floor(Math.random() * RANDOM_EMOJIS.length)],
                EMOJI_TOGGLE_URL: buildEmojiToggleUrl(chnl.id, urlEmoji === '1', sessionParam),
                MODE_TOGGLE_URL: modeToggleUrl,
                PAGE_TITLE: pageTitle,
                SEO_METADATA: generateSEOMetadata(req, {
                    title: pageTitle,
                    description: seoDescription,
                }),
                // Wii-only tokens — empty for the standard layout.
                EXTRA_HEAD: '',
                FORM_WRAPPER_OPEN: '',
                FORM_WRAPPER_CLOSE: '',
                MSG_INPUT_STYLE_ATTR: '',
                SEND_BTN_STYLE_ATTR: '',
            });
            // Inline draw.js so the script runs after the DOM is parsed (see inlineDrawJs).
            finalTemplate = inlineDrawJs(finalTemplate);
            res.writeHead(200, NO_CACHE_HTML_HEADERS);
            res.end(finalTemplate);
        } else {
            return notFound.serve404(req, res, 'Invalid channel.', '/', 'Back to Home');
        }
    } catch (error) {
        console.error(error);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        if ((error.message || error).toString().includes('error reading from remote stream')) {
            res.end(getTemplate('proxy-timeout-error', 'misc'));
        } else {
            res.end(getTemplate('generic-error', 'misc'));
        }
    }
};
