'use strict';
const Discord = require('discord.js');
const dns = require('dns').promises;
const https = require('https');

const auth = require('./authentication.js');
const connectionHandler = require('./connectionHandler.js');

const cachelength = 100; // Length of message history
const msghistory = {};

// Optionally enable Guild Members Intent for automatic server sync
const guildMembersIntentEnabled = process.env.GUILD_MEMBERS_INTENT === 'true';
const intentsArray = [
  Discord.GatewayIntentBits.Guilds,
  Discord.GatewayIntentBits.GuildMessages,
  Discord.GatewayIntentBits.MessageContent,
];
if (guildMembersIntentEnabled) {
  intentsArray.push(Discord.GatewayIntentBits.GuildMembers);
}

const client = new Discord.Client({
  partials: [Discord.Partials.Message, Discord.Partials.Channel],
  shards: 'auto',
  intents: intentsArray,
});

client.on('clientReady', () => {
  console.info(`Logged in as ${client.user.tag}!`);
});

client.on('messageCreate', async function (msg) {
  if (msghistory[msg.channel.id] && !msghistory[msg.channel.id].get(msg.id)) {
    msghistory[msg.channel.id].set(msg.id, msg);

    if (msghistory[msg.channel.id].size > cachelength) {
      // Delete the oldest entry (Maps preserve insertion order)
      msghistory[msg.channel.id].delete(msghistory[msg.channel.id].keys().next().value);
    }
  }

  if (msg.webhookId) {
    // TODO: Do properly
    connectionHandler.sendToAll(msg.content, msg.channel.id);
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
      await msg.reply('You have been sent a direct message with your verification code.');
    } catch (e) {
      await msg.reply(
        'Your verification code could not be sent. Please make sure you have direct messages enabled and try again.'
      );
    }
  } else if (msg.content === '^help') {
    await msg.reply(
      '**Discross Bot Commands:**\n`^connect` - Link your Discord account to Discross\n`^guest` - Toggle guest access for this channel (requires Manage Channel permission)\n`^help` - Show this help message'
    );
  } else if (msg.content === '^guest') {
    if (!msg.guild) {
      await msg.reply('This command can only be used in a server channel.');
      return;
    }
    try {
      const member = await msg.guild.members.fetch(msg.author.id);
      if (!member.permissionsIn(msg.channel).has(Discord.PermissionFlagsBits.ManageChannels)) {
        await msg.reply('You need the Manage Channel permission to use this command.');
        return;
      }
      const enabled = auth.toggleGuestChannel(msg.channel.id);
      await msg.reply(
        `Guest access for this channel has been **${enabled ? 'enabled' : 'disabled'}**.`
      );
    } catch (e) {
      await msg.reply('An error occurred while toggling guest access.');
    }
  }

  // TODO: Do properly
  connectionHandler.sendToAll(msg.content, msg.channel.id);
});

// Auto-sync server membership when GuildMembers intent is enabled
if (guildMembersIntentEnabled) {
  client.on('guildMemberAdd', (member) => {
    // Only add the server if the user is a registered Discross user
    const user = auth.dbQuerySingle('SELECT discordID FROM users WHERE discordID=?', [
      member.user.id,
    ]);
    if (user) {
      auth.insertServers([
        { serverID: member.guild.id, discordID: member.user.id, icon: member.guild.icon },
      ]);
    }
  });

  client.on('guildMemberRemove', (member) => {
    auth.dbQueryRun('DELETE FROM servers WHERE serverID=? AND discordID=?', [
      member.guild.id,
      member.user.id,
    ]);
  });
}

exports.startBot = async function () {
  if (process.env.TOKEN) {
    client.login(process.env.TOKEN);
  } else {
    console.error('No token found! Please set the TOKEN environment variable to your bot token.');
    process.exit(1);
  }
};

exports.addToCache = function (msg) {
  if (msghistory[msg.channel.id]) {
    msghistory[msg.channel.id].set(msg.id, msg);
  }
};

exports.getHistoryCached = async function (chnl) {
  if (!chnl.id) {
    chnl = client.channels.cache.get(chnl);
  }
  if (!msghistory[chnl.id]) {
    // Fetch messages - Discord.js will try to populate member data automatically if available in cache
    const messagearray = await chnl.messages.fetch({ limit: cachelength });
    msghistory[chnl.id] = messagearray.sort(
      (messageA, messageB) => messageA.createdTimestamp - messageB.createdTimestamp
    );
  }
  return Array.from(msghistory[chnl.id].values());
};

exports.client = client;

let cachedCheck = null;
let lastCheckTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function shouldSendDM() {
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
      console.info(`DM suppressed: Server IP (${myIp}) does not match discross.net (${targetIp})`);
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
