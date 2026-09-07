'use strict';

const auth = require('../src/authentication');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const { convertEmoji } = require('./emojiConvert');
const { getOrCreateWebhook } = require('./webhookCache');
const {
    isValidSnowflake,
    isBotReady,
    isCrossSiteRequest,
    parseCookies,
    getBaseUrl,
    sanitizeGuestName,
    sanitizeWebhookUsername,
    getTemplate,
} = require('./utils');
const { checkAndMarkNonce } = require('./messageDedup');
const { verifyCaptchaPass } = require('./guestCaptcha');

exports.guestSend = async function guestSend(bot, req, res) {
    // Reject cross-site initiated guest sends (CSRF): the guest_name /
    // guest_captcha cookies are ambient, so a hostile page could otherwise post
    // as a visitor who has a guest session in a guest-enabled channel.
    if (isCrossSiteRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        res.end('Request blocked for security reasons.');
        return;
    }
    const parsedUrl = new URL(req.url, 'http://localhost');
    const channelId = parsedUrl.searchParams.get('channel');
    const rawMessage = parsedUrl.searchParams.get('message') || '';
    const cookies = parseCookies(req);
    const rawName = parsedUrl.searchParams.get('guest_name') || cookies.guest_name || '';
    const guestName = sanitizeGuestName(rawName);

    const baseUrl = getBaseUrl(req);

    // Validate channel id
    if (!isValidSnowflake(channelId)) {
        res.writeHead(302, { Location: baseUrl + '/' });
        res.end();
        return;
    }

    // Check guest mode is enabled for this channel
    if (!auth.isGuestChannel(channelId)) {
        res.writeHead(302, { Location: baseUrl + '/' });
        res.end();
        return;
    }

    // Validate guest name and the signed anti-spam captcha pass. The cookie is
    // HMAC-signed at issue time (see guestCaptcha.issueCaptchaPass), so a client
    // can't skip the captcha by setting a static value by hand.
    if (!guestName || !verifyCaptchaPass(cookies.guest_captcha)) {
        res.writeHead(302, { Location: baseUrl + '/channels/' + channelId });
        res.end();
        return;
    }

    // Check bot is ready
    if (!isBotReady(bot)) {
        res.writeHead(503, { 'Content-Type': 'text/html' });
        res.end(getTemplate('bot-not-connected', 'misc'));
        return;
    }

    // Fetch channel
    const channel = await bot.client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
        res.writeHead(302, { Location: baseUrl + '/' });
        res.end();
        return;
    }

    // Only send non-empty messages
    if (typeof rawMessage === 'string' && rawMessage.trim() !== '') {
        // Deduplicate: if this nonce was already processed, skip sending
        const nonce = parsedUrl.searchParams.get('nonce') || '';
        if (checkAndMarkNonce(nonce)) {
            res.writeHead(302, { Location: baseUrl + '/channels/' + channelId });
            res.end();
            return;
        }

        const processedMessage = convertEmoji(rawMessage);
        const webhook = await getOrCreateWebhook(channel, channel.guild.id);

        // Use the bot's avatar as the guest profile picture
        const avatarURL = bot.client.user.displayAvatarURL({ extension: 'png', size: 128 });

        const sendOptions = {
            content: processedMessage,
            username: sanitizeWebhookUsername((guestName || 'Guest') + ' (guest)'),
            avatarURL: avatarURL,
            // Guests are unauthenticated, so block ALL pings (users, roles,
            // @everyone/@here). (`disableEveryone` was the discord.js v11 option
            // and is silently ignored by v14.)
            allowedMentions: { parse: [] },
        };
        if (channel.isThread()) {
            sendOptions.threadId = channel.id;
        }
        const message = await webhook.send(sendOptions);

        const userAgent = req.headers['user-agent'];
        if (userAgent && message && message.id) {
            auth.queryRun(
                'INSERT OR REPLACE INTO message_user_agents (messageID, userAgent) VALUES (?, ?)',
                [message.id, userAgent]
            );
        }

        bot.addToCache(message);
    }

    res.writeHead(302, { Location: baseUrl + '/channels/' + channelId });
    res.end();
};
