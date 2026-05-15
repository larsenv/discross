'use strict';

const auth = require('../src/authentication.js');
const { getOrCreateWebhook } = require('./webhookCache');
const { parseUserAgent } = require('./userAgentUtils');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const discord = require('discord.js');

const { getTemplate, renderTemplate, render } = require('./utils.js');

exports.sendMeta = async function (bot, req, res, channelId) {
    const discordID = await auth.checkAuth(req, res);
    if (!discordID) return;

    const chnl = await bot.client.channels.fetch(channelId).catch(() => undefined);
    if (!chnl) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end(getTemplate('channel-not-found', 'misc'));
        return;
    }

    try {
        const parsedurl = new URL(req.url, 'http://localhost');
        const query = Object.fromEntries(parsedurl.searchParams);
        const resolvedMsg = query.message;

        const member = await chnl.guild.members.fetch(discordID).catch(() => null);
        if (!member || !member.permissionsIn(chnl).has(discord.PermissionFlagsBits.SendMessages)) {
            res.end(
                render('misc/error-text', {
                    MESSAGE: "You don't have permission to do that!",
                })
            );
            return;
        }

        const webhook = await getOrCreateWebhook(chnl, chnl.guild.id);

        const userAgentStr = req.headers['user-agent'];
        const client = parseUserAgent(userAgentStr);

        // Use discross.net as fallback if host is local or not provided,
        // to help Discord's proxy fetch the icons.
        let baseUrl = 'http://discross.net';
        const host = req.headers.host;
        if (host && !host.includes('localhost') && !host.includes('127.0.0.1')) {
            const proto = req.headers['x-forwarded-proto'] || 'http';
            baseUrl = `${proto}://${host}`;
        }

        const clientIcon = client
            ? `${baseUrl}/resources/images/clients/${client.id}.png`
            : `${baseUrl}/favicon.ico`;

        const footerText = client ? `Sent from ${client.name}` : 'Sent using Discross';

        const payload = {
            username: normalizeWeirdUnicode(member.displayName || member.user.tag),
            avatarURL: member.user.avatarURL() || member.user.defaultAvatarURL,
            embeds: [
                {
                    color: 0x5865f2,
                    title: 'Discross',
                    url: 'http://discross.net/',
                    description: resolvedMsg || '\u200b',
                    footer: {
                        text: footerText,
                        icon_url: clientIcon,
                    },
                },
            ],
        };

        const message = await webhook.send(payload);

        if (userAgentStr && message && message.id) {
            auth.dbQueryRun(
                'INSERT OR REPLACE INTO message_user_agents (messageID, userAgent) VALUES (?, ?)',
                [message.id, userAgentStr]
            );
        }

        const urlSessionID =
            new URL(req.url, 'http://localhost').searchParams.get('sessionID') || '';
        const sessionParam = urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '';

        res.writeHead(302, {
            Location: `/channels/${channelId}${sessionParam}`,
        });
        res.end();
    } catch (err) {
        console.error('Error sending meta webhook:', err);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(getTemplate('generic-error', 'misc'));
    }
};
