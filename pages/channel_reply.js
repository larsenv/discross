'use strict';
const escape = require('escape-html');
const { PermissionFlagsBits } = require('discord.js');
const { getDisplayName } = require('./memberUtils');
const { getClientIP, getTimezoneFromIP, formatDateWithTimezone } = require('../timezoneUtils');
const { buildMessagesHtml } = require('./channel');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const notFound = require('./notFound.js');
const {
    renderTemplate,
    isBotReady,
    parseCookies,
    resolveTheme,
    RANDOM_EMOJIS,
    buildSessionParam,
    buildEmojiToggleUrl,
    getTemplate,
    loadAndRenderPageTemplate,
} = require('./utils.js');

// Templates for viewing messages in a channel (Reply Context)
const channel_reply_bar_template = getTemplate('channel_reply_bar', 'partials');
const channel_template_base = loadAndRenderPageTemplate('channel');
const channel_template = renderTemplate(channel_template_base, {
    PAGE_CLASS: 'page-channel-reply',
    CONTENT_EXTRA_PADDING: '',
    EMOJI_PICKER: getTemplate('emoji_picker', 'partials'),
    EMOJI_BUTTON: getTemplate('emoji_picker_button', 'partials'),
    REPLY_MESSAGE_ID_INPUT: getTemplate('reply_message_id_input', 'channel'),
});

// Reply-specific message wrapper templates
const message_template = getTemplate('message_reply', 'message');
const message_forwarded_template = getTemplate('forwarded_message_reply', 'message');
const message_mentioned_template = getTemplate('message_reply_mentioned', 'message');
const message_forwarded_mentioned_template = getTemplate('forwarded_message_reply_mentioned', 'message');

// Shared templates (same as channel.js)
const first_message_content_template = getTemplate('first_message_content', 'message');
const merged_message_content_template = getTemplate('merged_message_content', 'message');
const mention_template = getTemplate('mention', 'message');
const input_template = getTemplate('input', 'channel');
const input_disabled_template = getTemplate('input_disabled', 'channel');
const no_message_history_template = getTemplate('no_message_history', 'channel');
const file_download_template = getTemplate('file_download', 'channel');
const reactions_template = getTemplate('reactions', 'message');
const reaction_template = getTemplate('reaction', 'message');
const date_separator_template = getTemplate('date_separator', 'message');
const REPLY_PREVIEW_MAX_LENGTH = 25;

function buildReplyPreviewContent(message) {
    // If the message has attachments, show "Attachment" instead of text preview
    if (message.attachments && message.attachments.size > 0) {
        return 'Attachment';
    }

    const flattened = message.content.replace(/\s+/g, ' ').trim();
    let preview = flattened;

    message.mentions?.users?.forEach((user) => {
        if (!user) return;
        const member = message.mentions?.members?.get(user.id);
        const mentionName =
            '@' +
            normalizeWeirdUnicode(
                member
                    ? getDisplayName(member, user)
                    : (user.displayName ?? user.globalName ?? user.username)
            );
        preview = preview.replace(new RegExp(`<@!?${user.id}>`, 'g'), mentionName);
    });

    const chars = Array.from(preview);
    if (chars.length > REPLY_PREVIEW_MAX_LENGTH) {
        preview = chars.slice(0, REPLY_PREVIEW_MAX_LENGTH).join('') + '...';
    }
    if (!preview) return ''; // Prevent empty <br>
    return escape(preview);
}

exports.processChannelReply = async function processChannelReply(bot, req, res, args, discordID) {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
    const urlTheme = parsedUrl.searchParams.get('theme');
    const urlImages = parsedUrl.searchParams.get('images');
    const urlEmoji = parsedUrl.searchParams.get('emoji');

    const { whiteThemeCookie, images: imagesCookieValue } = parseCookies(req);

    // Build combined URL params for links — only include preference params when the
    // corresponding cookie is absent (i.e. the browser doesn't support cookies)
    const sessionParam = buildSessionParam(
        urlSessionID,
        urlTheme,
        whiteThemeCookie,
        urlImages,
        imagesCookieValue
    );

    const themeObj = resolveTheme(req);
    const { authorText, replyText, themeClass, boxColor } = themeObj;
    const baseTemplate = renderTemplate(channel_template, {
        WHITE_THEME_ENABLED: themeClass,
    });
    const imagesCookie =
        urlImages !== null
            ? parseInt(urlImages, 10)
            : imagesCookieValue !== undefined
              ? parseInt(imagesCookieValue, 10)
              : 1;

    const clientTimezone = getTimezoneFromIP(req);

    const emojiDisplay = urlEmoji === '1' ? '' : 'display: none;';
    // args[3] is the reply message ID — the current page's relative URL segment
    const emojiToggleUrl = buildEmojiToggleUrl(args[3], urlEmoji === '1', sessionParam);

    try {
        if (!isBotReady(bot)) {
            res.writeHead(503, { 'Content-Type': 'text/html' });
            res.end(getTemplate('bot_not_connected', 'misc'));
            return;
        }

        const chnl = await bot.client.channels.fetch(args[2]).catch(() => undefined);

        if (chnl) {
            const botMember = await chnl.guild.members.fetch(bot.client.user.id).catch(() => null);
            if (!botMember) {
                res.writeHead(503, { 'Content-Type': 'text/html' });
                res.end(getTemplate('not_in_server', 'misc'));
                return;
            }

            const member = await chnl.guild.members.fetch(discordID).catch(() => null);
            if (!member) {
                res.writeHead(403, { 'Content-Type': 'text/html' });
                res.end(getTemplate('join_server_to_view', 'misc'));
                return;
            }

            const canView = await require('./utils.js').canViewChannel(member, botMember, chnl);
            if (!canView) {
                res.writeHead(403, { 'Content-Type': 'text/html' });
                res.end(getTemplate('no_permission', 'misc'));
                return;
            }

            if (!member.permissionsIn(chnl).has(PermissionFlagsBits.ReadMessageHistory, true)) {
                const final = renderTemplate(baseTemplate, {
                    SERVER_ID: chnl.guild.id,
                    CHANNEL_ID: chnl.id,
                    CHANNEL_REPLY: '',
                    INPUT: member.permissionsIn(chnl).has(PermissionFlagsBits.SendMessages, true)
                        ? input_template
                        : input_disabled_template,
                    COLOR: boxColor,
                    MESSAGES: no_message_history_template,
                    SESSION_ID: urlSessionID,
                    SESSION_PARAM: sessionParam,
                    EMOJI_DISPLAY: emojiDisplay,
                    EMOJI_TOGGLE_URL: emojiToggleUrl,
                });
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(final);
                return;
            }

            const response = await buildMessagesHtml({
                bot,
                chnl,
                member,
                discordID,
                req,
                imagesCookie,
                authorText,
                replyText,
                clientTimezone,
                channelId: null, // no reply links in reply context
                templates: {
                    message: message_template,
                    messageForwarded: message_forwarded_template,
                    messageMentioned: message_mentioned_template,
                    messageForwardedMentioned: message_forwarded_mentioned_template,
                    firstMessageContent: first_message_content_template,
                    mergedMessageContent: merged_message_content_template,
                    mention: mention_template,
                    fileDownload: file_download_template,
                    reactions: reactions_template,
                    reaction: reaction_template,
                    dateSeparator: date_separator_template,
                },
            });

            const template = renderTemplate(baseTemplate, {
                SERVER_ID: chnl.guild.id,
                CHANNEL_ID: chnl.id,
                REFRESH_URL:
                    chnl.id +
                    '?random=' +
                    Math.random() +
                    (urlSessionID ? '&sessionID=' + encodeURIComponent(urlSessionID) : ''),
            });
            const noWebhooks = !botMember
                .permissionsIn(chnl)
                .has(PermissionFlagsBits.ManageWebhooks, true);
            const canSend = member.permissionsIn(chnl).has(PermissionFlagsBits.SendMessages, true);
            const inputTpl = noWebhooks || !canSend ? input_disabled_template : input_template;
            let templateWithInput = renderTemplate(template, {
                INPUT: inputTpl,
                COLOR: boxColor,
            });
            const afterWebhookCheck = noWebhooks
                ? templateWithInput.replace(
                      "You don't have permission to send messages in this channel.",
                      "Discross bot doesn't have the Manage Webhooks permission"
                  )
                : templateWithInput;

            // Reply context: fetch and display the message being replied to
            const reply_message_id = args[3];
            try {
                const message = await chnl.messages.fetch(reply_message_id);
                const message_content = buildReplyPreviewContent(message);

                const author = await chnl.guild.members
                    .fetch(message.author.id)
                    .then((replyMember) => getDisplayName(replyMember, message.author))
                    .catch(() => getDisplayName(null, message.author));

                const randomEmoji = RANDOM_EMOJIS[Math.floor(Math.random() * RANDOM_EMOJIS.length)];
                const replyBar = renderTemplate(channel_reply_bar_template, {
                    REPLY_MESSAGE_AUTHOR: escape(author),
                    REPLY_MESSAGE_CONTENT: message_content,
                });
                const final = renderTemplate(afterWebhookCheck, {
                    CHANNEL_REPLY: replyBar,
                    REPLY_MESSAGE_ID: reply_message_id,
                    RANDOM_EMOJI: randomEmoji,
                    CHANNEL_NAME: normalizeWeirdUnicode(chnl.name),
                    MESSAGES: response,
                    SESSION_ID: urlSessionID,
                    SESSION_PARAM: sessionParam,
                    EMOJI_DISPLAY: emojiDisplay,
                    EMOJI_TOGGLE_URL: emojiToggleUrl,
                });
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(final);
            } catch (err) {
                return notFound.serve404(
                    req,
                    res,
                    'Invalid message to reply to.',
                    '/',
                    'Back to Home'
                );
            }
        } else {
            return notFound.serve404(req, res, 'Invalid channel.', '/', 'Back to Home');
        }
    } catch (error) {
        console.error(error);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(getTemplate('generic_error', 'misc'));
    }
};
