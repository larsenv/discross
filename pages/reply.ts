'use strict';
const discord = require('discord');
const auth = require('../src/authentication');
const { convertEmoji } = require('./emojiConvert');
const { getOrCreateWebhook } = require('./webhookCache');
const {
    isBotReady,
    resolveMentions,
    resolveNameMentions,
    mentionsToReadableText,
    buildAllowedMentions,
    canMentionEveryoneIn,
    getTemplate,
    renderTemplate,
    render,
} = require('./utils');

exports.replyMessage = async function replyMessage(bot, req, res, args, discordID) {
    try {
        const parsedurl = new URL(req.url, 'http://localhost');
        if (
            parsedurl.searchParams.get('message') !== null &&
            parsedurl.searchParams.get('message') !== ''
        ) {
            // Check if bot is connected
            if (!isBotReady(bot)) {
                res.writeHead(503, { 'Content-Type': 'text/html' });
                res.end(getTemplate('bot-not-connected', 'misc'));
                return;
            }

            const channel = await bot.client.channels.fetch(parsedurl.searchParams.get('channel'));
            if (!channel) {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end(getTemplate('channel-not-found', 'misc'));
                return;
            }

            const member = await channel.guild.members.fetch(discordID).catch((err) => {
                console.error('Failed to fetch member:', err);
                return null;
            });
            if (!member) {
                res.writeHead(500, { 'Content-Type': 'text/html' });
                res.end(
                    render('misc/error-text', {
                        MESSAGE:
                            'Failed to verify user permissions. Please ensure you have access to this channel or try again later.',
                    })
                );
                return;
            }

            if (!member.permissionsIn(channel).has(discord.PermissionFlagsBits.SendMessages)) {
                res.writeHead(403, { 'Content-Type': 'text/html' });
                res.end(
                    render('misc/error-text', {
                        MESSAGE: "You don't have permission to do that!",
                    })
                );
                return;
            }

            const webhook = await getOrCreateWebhook(channel, channel.guild.id);

            const canPingEveryone = canMentionEveryoneIn(member, channel);
            const resolvedMsg = resolveNameMentions(
                await resolveMentions(
                    convertEmoji(parsedurl.searchParams.get('message') || ''),
                    channel.guild
                ),
                channel.guild,
                canPingEveryone
            );

            const reply_message = await channel.messages.fetch(
                parsedurl.searchParams.get('reply_message_id')
            );
            // Verify the reply message belongs to the channel to prevent reply spoofing
            if (reply_message.channelId !== channel.id) {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end(
                    render('misc/error-text', {
                        MESSAGE: 'Reply message does not belong to this channel',
                    })
                );
                return;
            }
            // Resolve mentions to readable names (falling back to generic
            // labels) so the quote never shows raw markup or a half-cut tag.
            const rawReplyContent = mentionsToReadableText(reply_message.content, channel.guild);
            // #38: Escape mentions in reply content to prevent ping issues
            const reply_message_content =
                rawReplyContent.length > 30
                    ? rawReplyContent.substring(0, 30) + '...'
                    : rawReplyContent;

            // #39: Get proper member name for reply
            const author_name = await channel.guild.members
                .fetch(reply_message.author.id)
                .then((m) => m.displayName || m.user.username)
                .catch(() => reply_message.author.username);

            const processedmessage = `> Replying to ${reply_message_content} from ${author_name}: [jump](https://discord.com/channels/${channel.guild.id}/${channel.id}/${reply_message.id})\n${resolvedMsg}`;

            const sendOptions: any = {
                content: processedmessage,
                username: member.displayName || member.user.tag,
                avatarURL: member.user.avatarURL() || member.user.defaultAvatarURL,
                // Webhooks bypass the member's own mention permissions, so every
                // ping is re-checked against what this member could do natively.
                // (`disableEveryone` was the discord.js v11 option and is
                // silently ignored by v14.)
                allowedMentions: buildAllowedMentions(processedmessage, member, channel),
            };

            if (channel.isThread()) {
                sendOptions.threadId = channel.id;
            }

            const message = await webhook.send(sendOptions);

            const userAgentStr = req.headers['user-agent'];
            if (userAgentStr && message && message.id) {
                auth.queryRun(
                    'INSERT OR REPLACE INTO message_user_agents (messageID, userAgent) VALUES (?, ?)',
                    [message.id, userAgentStr]
                );
            }

            bot.addToCache(message);
        }

        res.writeHead(302, { Location: `/channels/${parsedurl.searchParams.get('channel')}#end` });
        res.end();
    } catch (err) {
        console.error('Error sending message:', err);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(
            getTemplate('generic-error', 'misc').replace(
                '{{ERROR_DETAILS}}',
                (err as Error).message || 'Unknown error occurred while replying.'
            )
        );
    }
};
