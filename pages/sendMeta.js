'use strict';

const auth = require('../authentication.js');
const { getOrCreateWebhook } = require('./webhookCache');

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
        const webhook = await getOrCreateWebhook(chnl, chnl.guild.id);
        
        const payload = {
            content: "Hi",
            embeds: [
                {
                    color: 3447003,
                    description: "-# [Sent using Internet Explorer with Discross](http://discross.net/)",
                    image: {
                        url: "http://47.186.1.61:4000/resources/images/clients/ie.png"
                    }
                }
            ]
        };

        await webhook.send(payload);

        const urlSessionID = new URL(req.url, 'http://localhost').searchParams.get('sessionID') || '';
        const sessionParam = urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '';
        
        res.writeHead(302, {
            Location: `/channels/${channelId}${sessionParam}`
        });
        res.end();
    } catch (err) {
        console.error('Error sending meta webhook:', err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Failed to send message');
    }
};
