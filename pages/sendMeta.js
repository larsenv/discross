'use strict';

const auth = require('../authentication.js');
const { getOrCreateWebhook } = require('./webhookCache');
const { parseUserAgent } = require('./userAgentUtils');
const { normalizeWeirdUnicode } = require('./utils.js');
const discord = require('discord.js');

exports.sendMeta = async function (bot, req, res, channelId) {
    const discordID = await auth.checkAuth(req, res);
    if (!discordID) return;

    const chnl = await bot.client.channels.fetch(channelId).catch(() => undefined);
    if (!chnl) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Channel not found');
        return;
    }

    try {
        const member = await chnl.guild.members.fetch(discordID).catch(() => null);
        if (
            !member ||
            !member.permissionsIn(chnl).has(discord.PermissionFlagsBits.SendMessages)
        ) {
            res.end("You don't have permission to do that!");
            return;
        }

        const webhook = await getOrCreateWebhook(chnl, chnl.guild.id);

        const userAgentStr = req.headers['user-agent'];
        const client = parseUserAgent(userAgentStr);
        const clientName = client ? client.name : 'Unknown Client';
        const baseUrl = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
        const clientIcon = client
            ? `${baseUrl}/resources/images/clients/${client.id}.png`
            : `${baseUrl}/resources/logo.gif`;

        const payload = {
            username: normalizeWeirdUnicode(member.displayName || member.user.tag),
            avatarURL: member.user.avatarURL() || member.user.defaultAvatarURL,
            embeds: [
                {
                    color: 0x5865f2,
                    description: 'Hi',
                    footer: {
                        text: `Sent using Discross from ${clientName}`,
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
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Failed to send message');
    }
};

