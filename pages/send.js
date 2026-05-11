'use strict';
const discord = require('discord.js');
const auth = require('../authentication.js');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const { convertEmoji } = require('./emojiConvert');
const { getOrCreateWebhook } = require('./webhookCache');
const {
    isValidSnowflake,
    isBotReady,
    getBaseUrl,
    resolveMentions,
    renderTemplate,
    getTemplate,
} = require('./utils.js');
const { checkAndMarkNonce } = require('./messageDedup.js');

const { parseUserAgent } = require('./userAgentUtils');

exports.sendMessage = async function sendMessage(bot, req, req_res, args, discordID) {
    const baseUrl = getBaseUrl(req);
    try {
        const parsedurl = new URL(req.url, 'http://localhost');
        const query = Object.fromEntries(parsedurl.searchParams);

        // Ensure message exists and is a non-empty string
        if (typeof query.message === 'string' && query.message !== '') {
            // Deduplicate: if this nonce was already processed, skip sending
            if (checkAndMarkNonce(query.nonce)) {
                const redirectChannel = parsedurl.searchParams.get('channel') || args?.[2] || '';
                const sessionID = parsedurl.searchParams.get('sessionID') || '';
                const sessionPart = sessionID ? `?sessionID=${encodeURIComponent(sessionID)}` : '';
                req_res.writeHead(302, {
                    Location: `${baseUrl}/channels/${redirectChannel}${sessionPart}`,
                });
                req_res.end();
                return;
            }

            const channelId = query.channel || query.channel_id || args?.[2];

            // Check if bot is connected
            if (!isBotReady(bot)) {
                req_res.writeHead(503, { 'Content-Type': 'text/html' });
                req_res.end(getTemplate('bot-not-connected', 'misc'));
                return;
            }

            // Validate channel id format early
            if (!channelId || !isValidSnowflake(channelId)) {
                req_res.writeHead(404, { 'Content-Type': 'text/html' });
                req_res.end(getTemplate('invalid-channel', 'misc'));
                return;
            }

            // Attempt to fetch channel, handle failures gracefully
            const channel = await bot.client.channels.fetch(channelId).catch((err) => {
                console.error('Channel fetch error:', err);
                return null;
            });

            if (!channel) {
                req_res.writeHead(404, { 'Content-Type': 'text/html' });
                req_res.end(getTemplate('invalid-channel', 'misc'));
                return;
            }

            // Attempt to fetch member and check permissions
            const member = await channel.guild.members.fetch(discordID).catch((err) => {
                console.error('Member fetch error:', err);
                return null;
            });

            if (
                !member ||
                !member.permissionsIn(channel).has(discord.PermissionFlagsBits.SendMessages)
            ) {
                req_res.end(
                    renderTemplate(getTemplate('error-text', 'misc'), {
                        MESSAGE: "You don't have permission to do that!",
                    })
                );
                return;
            }

            const webhook = await getOrCreateWebhook(channel, channel.guild.id);

            const resolvedMsg = await resolveMentions(
                convertEmoji(query.message || ''),
                channel.guild
            );

            // Handle reply if reply_message_id is present
            const replyInfo =
                query.reply_message_id && isValidSnowflake(query.reply_message_id)
                    ? await (async () => {
                          try {
                              const reply_message = await channel.messages.fetch(
                                  query.reply_message_id
                              );
                              if (reply_message.channelId !== channel.id) {
                                  throw new Error('Reply message does not belong to this channel');
                              }
                              const reply_message_content =
                                  reply_message.content.length > 30
                                      ? `${reply_message.content.substring(0, 30)}...`
                                      : reply_message.content;
                              const author_id = reply_message.author.id;
                              const author_mention =
                                  author_id === discordID
                                      ? reply_message.author.username
                                      : `<@${author_id}>`;
                              return `> Replying to "${reply_message_content}" from ${author_mention}: [jump](https://discord.com/channels/${channel.guild.id}/${channel.id}/${reply_message.id})\n`;
                          } catch (err) {
                              console.error('Failed to fetch reply info:', err);
                              return '';
                          }
                      })()
                    : '';

            const userAgentStr = req.headers['user-agent'];

            // Reverted to plain content sending by default
            const finalMessage = replyInfo + resolvedMsg;

            const sendOptions = {
                content: finalMessage,
                username: normalizeWeirdUnicode(member.displayName || member.user.tag),
                avatarURL: member.user.avatarURL() || member.user.defaultAvatarURL,
                disableEveryone: true,
            };

            if (channel.isThread()) {
                sendOptions.threadId = channel.id;
            }

            const message = await webhook.send(sendOptions);

            if (userAgentStr && message && message.id) {
                auth.dbQueryRun(
                    'INSERT OR REPLACE INTO message_user_agents (messageID, userAgent) VALUES (?, ?)',
                    [message.id, userAgentStr]
                );
            }

            bot.addToCache(message);
        }

        // redirect back to the channel
        const redirectChannel = parsedurl.searchParams.get('channel') || args?.[2] || '';
        const sessionID = parsedurl.searchParams.get('sessionID') || '';
        const sessionPart = sessionID ? `?sessionID=${encodeURIComponent(sessionID)}` : '';
        req_res.writeHead(302, {
            Location: `${baseUrl}/channels/${redirectChannel}${sessionPart}`,
        });
        req_res.end();
    } catch (err) {
        console.error('Error sending message:', err);
        req_res.writeHead(302, { Location: `${baseUrl}/server/` });
        req_res.end();
    }
};
