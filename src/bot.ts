'use strict';
const Discord = require('discord');
const dns = require('dns').promises;
const https = require('https');

const auth = require('./authentication');
const connectionHandler = require('./connectionHandler');
const mail = require('./mail');

const cachelength = 100; // Length of message history
const msghistory = new Map();
const MSGHISTORY_MAX_CHANNELS = 100; // Max number of channels to keep in history cache

async function safeReply(msg, content) {
    try {
        return await msg.reply(content);
    } catch (err) {
        if (err && (err.code === 160002 || err.code === 50013)) {
            try {
                return await msg.channel.send(content);
            } catch (e) {
                // Ignore if cannot send in channel either
            }
        }
        throw err;
    }
}

// Optionally enable Guild Members Intent for automatic server sync
const guildMembersIntentEnabled = process.env.GUILD_MEMBERS_INTENT === 'true';
const intentsArray = [
    Discord.GatewayIntentBits.Guilds,
    Discord.GatewayIntentBits.GuildMessages,
    Discord.GatewayIntentBits.MessageContent,
    Discord.GatewayIntentBits.DirectMessages,
];
if (guildMembersIntentEnabled) {
    intentsArray.push(Discord.GatewayIntentBits.GuildMembers);
}

const client = new Discord.Client({
    partials: [Discord.Partials.Message, Discord.Partials.Channel, Discord.Partials.Reaction],
    shards: 'auto',
    intents: intentsArray,
});

client.on('clientReady', async () => {
    console.info(`Logged in as ${client.user.tag}!`);
    try {
        await client.application.commands.set([
            {
                name: 'connect',
                description: 'Link your Discord account to Discross',
            },
            {
                name: 'guest',
                description:
                    'Toggle guest access for this channel (requires Manage Channel permission)',
            },
            {
                name: 'help',
                description: 'Show the help message',
            },
            {
                name: 'mail',
                description: 'Manage your Discross DM-based email account',
            },
        ]);
        console.info('Successfully registered global slash commands.');
    } catch (error) {
        console.error('Failed to register global slash commands:', error);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;

        if (commandName === 'connect') {
            if (!(await shouldSendDM())) {
                return;
            }
            try {
                await interaction.user.send(
                    `Verification code:\n\`${await auth.createVerificationCode(interaction.user.id)}\``
                );
                await interaction.reply({
                    content: 'You have been sent a direct message with your verification code.',
                    flags: Discord.MessageFlags.Ephemeral,
                });
            } catch (e) {
                await interaction.reply({
                    content:
                        'Your verification code could not be sent. Please make sure you have direct messages enabled and try again.',
                    flags: Discord.MessageFlags.Ephemeral,
                });
            }
        } else if (commandName === 'help') {
            await interaction.reply({
                content:
                    '**Discross Bot Commands:**\n`^connect` or `/connect` - Link your Discord account to Discross\n`^guest` or `/guest` - Toggle guest access for this channel (requires Manage Channel permission)\n`^help` or `/help` - Show this help message',
            });
        } else if (commandName === 'guest') {
            if (!interaction.guild) {
                await interaction.reply({
                    content: 'This command can only be used in a server channel.',
                    flags: Discord.MessageFlags.Ephemeral,
                });
                return;
            }
            try {
                const member = interaction.member;
                if (
                    !member
                        .permissionsIn(interaction.channel)
                        .has(Discord.PermissionFlagsBits.ManageChannels)
                ) {
                    await interaction.reply({
                        content: 'You need the Manage Channel permission to use this command.',
                        flags: Discord.MessageFlags.Ephemeral,
                    });
                    return;
                }
                const enabled = auth.toggleGuestChannel(interaction.channelId);
                await interaction.reply({
                    content: `Guest access for this channel has been **${enabled ? 'enabled' : 'disabled'}**.`,
                });
            } catch (e) {
                await interaction.reply({
                    content: 'An error occurred while toggling guest access.',
                    flags: Discord.MessageFlags.Ephemeral,
                });
            }
        } else if (commandName === 'mail') {
            if (interaction.guild) {
                return interaction.reply({
                    content: 'This command can only be used in DMs with the bot.',
                    flags: Discord.MessageFlags.Ephemeral,
                });
            }
            const row = new Discord.ActionRowBuilder().addComponents(
                new Discord.ButtonBuilder()
                    .setCustomId('mail_register')
                    .setLabel('Register Email')
                    .setStyle(Discord.ButtonStyle.Primary),
                new Discord.ButtonBuilder()
                    .setCustomId('mail_verify')
                    .setLabel('Verify Code')
                    .setStyle(Discord.ButtonStyle.Success),
                new Discord.ButtonBuilder()
                    .setCustomId('mail_toggle')
                    .setLabel('Toggle Opt-In/Out')
                    .setStyle(Discord.ButtonStyle.Secondary),
                new Discord.ButtonBuilder()
                    .setCustomId('mail_send')
                    .setLabel('Send Email')
                    .setStyle(Discord.ButtonStyle.Primary)
            );
            await interaction.reply({
                content:
                    '**Discross Mail System**\nUse the buttons below to manage your email account.',
                components: [row],
                flags: Discord.MessageFlags.Ephemeral,
            });
        }
    }

    if (interaction.isButton()) {
        const { customId } = interaction;
        if (customId === 'mail_register') {
            const user = auth.getMailUser(interaction.user.id);
            if (user) {
                return interaction.reply({
                    content: `You are already registered with \`${user.email_prefix}@mail.discross.net\`. Email prefix cannot be changed.`,
                    flags: Discord.MessageFlags.Ephemeral,
                });
            }
            const modal = new Discord.ModalBuilder()
                .setCustomId('mail_register_modal')
                .setTitle('Register Email');
            modal.addComponents(
                new Discord.ActionRowBuilder().addComponents(
                    new Discord.TextInputBuilder()
                        .setCustomId('prefix')
                        .setLabel('Desired Email Prefix (before @)')
                        .setStyle(Discord.TextInputStyle.Short)
                        .setMinLength(5)
                        .setMaxLength(32)
                        .setRequired(true)
                ),
                new Discord.ActionRowBuilder().addComponents(
                    new Discord.TextInputBuilder()
                        .setCustomId('backup')
                        .setLabel('Backup Email (for verification)')
                        .setStyle(Discord.TextInputStyle.Short)
                        .setRequired(true)
                )
            );
            await interaction.showModal(modal);
        } else if (customId === 'mail_verify') {
            const modal = new Discord.ModalBuilder()
                .setCustomId('mail_verify_modal')
                .setTitle('Verify Email');
            modal.addComponents(
                new Discord.ActionRowBuilder().addComponents(
                    new Discord.TextInputBuilder()
                        .setCustomId('code')
                        .setLabel('6-Digit Verification Code')
                        .setStyle(Discord.TextInputStyle.Short)
                        .setMinLength(6)
                        .setMaxLength(6)
                        .setRequired(true)
                )
            );
            await interaction.showModal(modal);
        } else if (customId === 'mail_toggle') {
            const res = auth.toggleMailOptOut(interaction.user.id);
            if (!res.success) {
                return interaction.reply({
                    content: res.error,
                    flags: Discord.MessageFlags.Ephemeral,
                });
            }
            return interaction.reply({
                content: `Your email account is now **${res.active ? 'Active' : 'Disabled (Opted Out)'}**.`,
                flags: Discord.MessageFlags.Ephemeral,
            });
        } else if (customId.startsWith('mail_block:')) {
            const blockEmail = customId.split(':').slice(1).join(':');
            auth.addMailBlock(interaction.user.id, blockEmail);
            return interaction.reply({
                content: `Successfully blocked \`${blockEmail}\`.`,
                flags: Discord.MessageFlags.Ephemeral,
            });
        } else if (customId === 'mail_delete') {
            await interaction.deferUpdate().catch(() => {});
            await interaction.message.delete().catch(() => {});
        } else if (customId === 'mail_send') {
            const user = auth.getMailUser(interaction.user.id);
            if (!user || !user.active) {
                return interaction.reply({
                    content:
                        'You need to register and verify your email account first before you can send emails.',
                    flags: Discord.MessageFlags.Ephemeral,
                });
            }
            const modal = new Discord.ModalBuilder()
                .setCustomId('mail_send_modal')
                .setTitle('Send New Email');
            modal.addComponents(
                new Discord.ActionRowBuilder().addComponents(
                    new Discord.TextInputBuilder()
                        .setCustomId('to')
                        .setLabel('To (Recipient Email Address)')
                        .setStyle(Discord.TextInputStyle.Short)
                        .setPlaceholder('recipient@example.com')
                        .setRequired(true)
                ),
                new Discord.ActionRowBuilder().addComponents(
                    new Discord.TextInputBuilder()
                        .setCustomId('subject')
                        .setLabel('Subject')
                        .setStyle(Discord.TextInputStyle.Short)
                        .setPlaceholder('Enter subject')
                        .setRequired(false)
                ),
                new Discord.ActionRowBuilder().addComponents(
                    new Discord.TextInputBuilder()
                        .setCustomId('body')
                        .setLabel('Message Body')
                        .setStyle(Discord.TextInputStyle.Paragraph)
                        .setPlaceholder('Write your message here...')
                        .setRequired(true)
                )
            );
            await interaction.showModal(modal);
        } else if (customId.startsWith('mail_reply:')) {
            const replyTo = customId.split(':').slice(1).join(':');
            const modal = new Discord.ModalBuilder()
                .setCustomId(`mail_reply_modal:${replyTo}`)
                .setTitle(`Reply to ${replyTo.substring(0, 20)}`);
            modal.addComponents(
                new Discord.ActionRowBuilder().addComponents(
                    new Discord.TextInputBuilder()
                        .setCustomId('subject')
                        .setLabel('Subject')
                        .setStyle(Discord.TextInputStyle.Short)
                        .setRequired(false)
                ),
                new Discord.ActionRowBuilder().addComponents(
                    new Discord.TextInputBuilder()
                        .setCustomId('body')
                        .setLabel('Message Body')
                        .setStyle(Discord.TextInputStyle.Paragraph)
                        .setRequired(true)
                )
            );
            await interaction.showModal(modal);
        }
    }

    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'mail_register_modal') {
            const prefix = interaction.fields.getTextInputValue('prefix').toLowerCase();
            const backup = interaction.fields.getTextInputValue('backup');

            if (!/^[a-z0-9._-]+$/.test(prefix)) {
                return interaction.reply({
                    content:
                        'Invalid prefix. Use only alphanumeric characters, dots, underscores, or dashes.',
                    flags: Discord.MessageFlags.Ephemeral,
                });
            }
            if (auth.getMailUserByEmail(prefix)) {
                return interaction.reply({
                    content: `The email prefix \`${prefix}\` is already taken.`,
                    flags: Discord.MessageFlags.Ephemeral,
                });
            }

            const code = auth.createMailVerificationCode(interaction.user.id, prefix, backup);
            await mail.sendVerificationEmail(backup, code, interaction.user.username);

            await interaction.reply({
                content: `A verification code has been sent to \`${backup}\`! Click the "Verify Code" button to enter it.`,
                flags: Discord.MessageFlags.Ephemeral,
            });
        } else if (interaction.customId === 'mail_verify_modal') {
            const code = interaction.fields.getTextInputValue('code');
            const res = auth.verifyMailCode(interaction.user.id, code);
            if (!res.success) {
                return interaction.reply({
                    content: res.error,
                    flags: Discord.MessageFlags.Ephemeral,
                });
            }
            auth.setMailUser(interaction.user.id, res.email_prefix, 1);
            await interaction.reply({
                content: `Successfully registered \`${res.email_prefix}@mail.discross.net\`! You are now opted in to receive emails.`,
                flags: Discord.MessageFlags.Ephemeral,
            });
        } else if (interaction.customId === 'mail_send_modal') {
            const toAddress = interaction.fields.getTextInputValue('to');
            const subject = interaction.fields.getTextInputValue('subject') || 'No Subject';
            const body = interaction.fields.getTextInputValue('body');

            await interaction.deferReply({ flags: Discord.MessageFlags.Ephemeral });
            const res = await mail.sendEmail(interaction.user.id, toAddress, subject, body);
            if (res.success) {
                await interaction.editReply({
                    content: `Successfully sent email to \`${toAddress}\`!`,
                });
            } else {
                await interaction.editReply({ content: `Failed to send email: ${res.error}` });
            }
        } else if (interaction.customId.startsWith('mail_reply_modal:')) {
            const replyTo = interaction.customId.split(':').slice(1).join(':');
            const subject = interaction.fields.getTextInputValue('subject') || 'Re: ';
            const body = interaction.fields.getTextInputValue('body');

            await interaction.deferReply({ flags: Discord.MessageFlags.Ephemeral });
            const res = await mail.sendEmail(interaction.user.id, replyTo, subject, body);
            if (res.success) {
                await interaction.editReply({ content: `Successfully replied to \`${replyTo}\`!` });
            } else {
                await interaction.editReply({ content: `Failed to send reply: ${res.error}` });
            }
        }
    }
});

client.on('messageCreate', async function (msg) {
    if (msghistory.has(msg.channel.id) && !msghistory.get(msg.channel.id).get(msg.id)) {
        msghistory.get(msg.channel.id).set(msg.id, msg);

        if (msghistory.get(msg.channel.id).size > cachelength) {
            // Delete the oldest entry (Maps preserve insertion order)
            msghistory
                .get(msg.channel.id)
                .delete(msghistory.get(msg.channel.id).keys().next().value);
        }
    }

    if (!msg.content) return;

    if (msg.webhookId) {
        // TODO: Do properly
        await connectionHandler.sendToAll(msg.content, msg.channel.id);
        return;
    }

    if (msg.content === '^connect') {
        if (!(await shouldSendDM())) {
            // Don't reply if not the primary server to avoid multiple replies from different instances
            return;
        }
        try {
            await msg.author.send(
                `Verification code:\n\`${await auth.createVerificationCode(msg.author.id)}\``
            );
            await safeReply(
                msg,
                'You have been sent a direct message with your verification code.'
            );
        } catch (e) {
            await safeReply(
                msg,
                'Your verification code could not be sent. Please make sure you have direct messages enabled and try again.'
            );
        }
    } else if (msg.content === '^help') {
        await safeReply(
            msg,
            '**Discross Bot Commands:**\n`^connect` or `/connect` - Link your Discord account to Discross\n`^guest` or `/guest` - Toggle guest access for this channel (requires Manage Channel permission)\n`^help` or `/help` - Show this help message'
        );
    } else if (msg.content === '^guest') {
        if (!msg.guild) {
            await safeReply(msg, 'This command can only be used in a server channel.');
            return;
        }
        try {
            const member = await msg.guild.members.fetch(msg.author.id);
            if (
                !member.permissionsIn(msg.channel).has(Discord.PermissionFlagsBits.ManageChannels)
            ) {
                await safeReply(msg, 'You need the Manage Channel permission to use this command.');
                return;
            }
            const enabled = auth.toggleGuestChannel(msg.channel.id);
            await safeReply(
                msg,
                `Guest access for this channel has been **${enabled ? 'enabled' : 'disabled'}**.`
            );
        } catch (e) {
            await safeReply(msg, 'An error occurred while toggling guest access.');
        }
    } else if (msg.content === '^mail') {
        if (msg.guild) {
            return safeReply(msg, 'This command can only be used in DMs with the bot.');
        }
        const row = new Discord.ActionRowBuilder().addComponents(
            new Discord.ButtonBuilder()
                .setCustomId('mail_register')
                .setLabel('Register Email')
                .setStyle(Discord.ButtonStyle.Primary),
            new Discord.ButtonBuilder()
                .setCustomId('mail_verify')
                .setLabel('Verify Code')
                .setStyle(Discord.ButtonStyle.Success),
            new Discord.ButtonBuilder()
                .setCustomId('mail_toggle')
                .setLabel('Toggle Opt-In/Out')
                .setStyle(Discord.ButtonStyle.Secondary),
            new Discord.ButtonBuilder()
                .setCustomId('mail_send')
                .setLabel('Send Email')
                .setStyle(Discord.ButtonStyle.Primary)
        );
        await safeReply(msg, {
            content:
                '**Discross Mail System**\nUse the buttons below to manage your email account.',
            components: [row],
        });
    }

    // Handle Discord native replies to emails via DM
    if (!msg.guild && msg.reference && msg.reference.messageId) {
        try {
            const referencedMessage = await msg.channel.messages.fetch(msg.reference.messageId);
            if (
                referencedMessage &&
                referencedMessage.author.id === client.user.id &&
                referencedMessage.embeds.length > 0
            ) {
                const embed = referencedMessage.embeds[0];
                const footerText = embed.footer ? embed.footer.text : '';
                if (footerText.startsWith('To: ')) {
                    const replyTo = embed.author.name;
                    const subject = `Re: ${embed.title || 'Email'}`;
                    let body = msg.content;
                    const attachments = [];
                    msg.attachments.forEach((att) => {
                        attachments.push({ filename: att.name, path: att.url });
                    });

                    const res = await mail.sendEmail(
                        msg.author.id,
                        replyTo,
                        subject,
                        body,
                        attachments
                    );
                    if (res.success) {
                        await safeReply(msg, 'Email reply sent successfully!');
                    } else {
                        await safeReply(msg, `Failed to send email: ${res.error}`);
                    }
                    return; // Stop processing further for native email replies
                }
            }
        } catch (e) {
            console.error('Error processing native reply', e);
        }
    }

    // TODO: Do properly
    await connectionHandler.sendToAll(msg.content, msg.channel.id);

    // Auto-sync server membership when a registered user sends a message
    // This ensures active servers are added to the user's list without manual sync.
    if (msg.guild && msg.author && !msg.author.bot) {
        const user = auth.querySingle('SELECT discordID FROM users WHERE discordID=?', [
            msg.author.id,
        ]);
        if (user) {
            auth.insertServers([
                { serverID: msg.guild.id, discordID: msg.author.id, icon: msg.guild.icon },
            ]);
        }
    }
});

client.on('messageUpdate', async function (oldMsg, newMsg) {
    if (newMsg.partial) {
        try {
            await newMsg.fetch();
        } catch (error) {
            return;
        }
    }
    if (
        newMsg.channel &&
        msghistory.has(newMsg.channel.id) &&
        msghistory.get(newMsg.channel.id).has(newMsg.id)
    ) {
        msghistory.get(newMsg.channel.id).set(newMsg.id, newMsg);
    }
});

client.on('messageDelete', async function (msg) {
    if (msg.channel && msghistory.has(msg.channel.id)) {
        msghistory.get(msg.channel.id).delete(msg.id);
    }
});

client.on('messageDeleteBulk', async function (messages) {
    messages.forEach((msg) => {
        if (msg.channel && msghistory.has(msg.channel.id)) {
            msghistory.get(msg.channel.id).delete(msg.id);
        }
    });
});

// Auto-sync server membership when GuildMembers intent is enabled
if (guildMembersIntentEnabled) {
    client.on('guildMemberAdd', (member) => {
        // Only add the server if the user is a registered Discross user
        const user = auth.querySingle('SELECT discordID FROM users WHERE discordID=?', [
            member.user.id,
        ]);
        if (user) {
            auth.insertServers([
                { serverID: member.guild.id, discordID: member.user.id, icon: member.guild.icon },
            ]);
        }
    });

    client.on('guildMemberRemove', (member) => {
        auth.queryRun('DELETE FROM servers WHERE serverID=? AND discordID=?', [
            member.guild.id,
            member.user.id,
        ]);
    });
}

exports.startBot = async function () {
    const token = process.env.DISCORD_TOKEN;
    if (token) {
        return new Promise((resolve, reject) => {
            client.once('clientReady', () => {
                resolve(client);
            });
            client.once('error', (err) => {
                reject(err);
            });
            client.login(token).catch(reject);
        });
    } else {
        console.error(
            'No token found! Please set the DISCORD_TOKEN environment variable to your bot token.'
        );
        process.exit(1);
    }
};

exports.addToCache = function (msg) {
    if (msghistory.has(msg.channel.id)) {
        msghistory.get(msg.channel.id).set(msg.id, msg);
    }
};

// Fetches any messages older than what's currently cached for a channel, up
// to cachelength total, without blocking the caller. Used to top up a cache
// that was seeded with a smaller-than-cachelength initial fetch (see
// getHistoryCached) so later requests for that channel still see full history.
async function backfillHistory(chnl, alreadyFetched) {
    if (alreadyFetched >= cachelength) return;

    const collection = msghistory.get(chnl.id);
    if (!collection || collection.size === 0) return;
    const oldestId = collection.first().id;

    try {
        const older = await chnl.messages.fetch({
            limit: cachelength - alreadyFetched,
            before: oldestId,
        });

        // The channel may have been evicted from the cache while this fetch was in flight.
        const current = msghistory.get(chnl.id);
        if (!current) return;

        for (const [id, msg] of older) {
            if (!current.has(id)) current.set(id, msg);
        }
        msghistory.set(
            chnl.id,
            current.sort(
                (messageA, messageB) => messageA.createdTimestamp - messageB.createdTimestamp
            )
        );
    } catch (err) {
        console.error(`Failed to backfill messages for channel ${chnl.id}:`, err);
    }
}

exports.getHistoryCached = async function (chnl, desiredLimit) {
    if (typeof chnl === 'string') {
        chnl =
            client.channels.cache.get(chnl) ||
            (await client.channels.fetch(chnl).catch(() => null));
    }
    if (!chnl || !chnl.id) {
        return [];
    }
    if (!msghistory.has(chnl.id)) {
        try {
            // FIFO eviction for channels
            if (msghistory.size >= MSGHISTORY_MAX_CHANNELS) {
                msghistory.delete(msghistory.keys().next().value);
            }

            // Only fetch as many messages as this request actually needs so we
            // don't hold up the response fetching messages a legacy client is
            // just going to slice off anyway. Discord.js will try to populate
            // member data automatically if available in cache.
            const initialLimit =
                desiredLimit != null ? Math.min(desiredLimit, cachelength) : cachelength;
            const messagearray = await chnl.messages.fetch({ limit: initialLimit });
            msghistory.set(
                chnl.id,
                messagearray.sort(
                    (messageA, messageB) => messageA.createdTimestamp - messageB.createdTimestamp
                )
            );

            // Top up the rest of the shared cache in the background so a
            // later, non-legacy request to this channel isn't stuck with only
            // the smaller slice a previous legacy client asked for.
            if (initialLimit < cachelength) {
                backfillHistory(chnl, initialLimit);
            }
        } catch (err) {
            console.error(`Failed to fetch messages for channel ${chnl.id}:`, err);
            return [];
        }
    }
    return Array.from(msghistory.get(chnl.id).values());
};

exports.client = client;

let cachedCheck = null;
let lastCheckTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function shouldSendDM() {
    if (process.env.ALLOW_ALL_DMS === 'true') {
        return true;
    }
    const now = Date.now();
    if (cachedCheck !== null && now - lastCheckTime < CACHE_TTL) {
        return cachedCheck;
    }

    try {
        // 1. Get IP of discross.net
        const discrossIps = await dns.resolve4('discross.net');
        const targetIp = discrossIps[0];

        // 2. Get public IP of this server
        const myIp = await new Promise((resolve, reject) => {
            https
                .get('https://api.ipify.org', (res) => {
                    let data = '';
                    res.on('data', (chunk) => (data += chunk));
                    res.on('end', () => resolve(data.trim()));
                })
                .on('error', reject);
        });

        cachedCheck = targetIp === myIp;
        lastCheckTime = now;
        if (!cachedCheck) {
            console.info(
                `DM suppressed: Server IP (${myIp}) does not match discross.net (${targetIp})`
            );
        }
        return cachedCheck;
    } catch (err) {
        console.error('Error in shouldSendDM IP check:', err);
        // On error, default to true to avoid breaking functionality
        return true;
    }
}

exports.sendDM = async function (discordID, message) {
    if (!(await shouldSendDM())) {
        return { success: false, error: 'DM suppressed: This instance is not the primary server.' };
    }
    try {
        const user = await client.users.fetch(discordID);
        await user.send(message);
        return { success: true };
    } catch (err) {
        console.error('Failed to send DM to', discordID, ':', err);
        return { success: false, error: err.message || 'Failed to send Discord DM.' };
    }
};

/**
 * Sends a 6-digit verification code to the user for a pizza order.
 * @param {string} discordID
 * @param {string} code
 * @returns {Promise<boolean>} True if sent successfully
 */
exports.sendPizzaVerification = async function (discordID, code) {
    const message = `**Your Discross Pizza verification code is:**\n\n# \`${code}\`\n\nIf you did not request this code, please ignore this message.`;
    const result = await exports.sendDM(discordID, message);
    return result.success;
};
