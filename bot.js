const fs = require('fs')
const Discord = require('discord.js')

const auth = require('./authentication.js')
const connectionHandler = require('./connectionHandler.js')

const cachelength = 100 // Length of message history
const msghistory = {}

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
  shards: "auto", 
  intents: intentsArray
})

// https://stackoverflow.com/questions/1967119/why-does-javascript-replace-only-first-instance-when-using-replace

client.on('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}!`)
})

client.on('messageCreate', async function (msg) {
  if (msghistory[msg.channel.id] && !(msghistory[msg.channel.id].get(msg.id))) {
    msghistory[msg.channel.id].set(msg.id, msg)

    if (msghistory[msg.channel.id].size > cachelength) {
      // Delete the oldest entry (Maps preserve insertion order)
      msghistory[msg.channel.id].delete(msghistory[msg.channel.id].keys().next().value)
    }
  }

  if (msg.content === '^connect') {
    if (msg.webhookId) {
      msg.reply("You're already using Discross!")
    } else {
      msg.author.send('Verification code:\n`' + (await auth.createVerificationCode(msg.author.id)) + '`')
      msg.reply('You have been sent a direct message with your verification code.')
    }
  }

  // TODO: Do properly
  connectionHandler.sendToAll(msg.content, msg.channel.id)
})

// Auto-sync server membership when GuildMembers intent is enabled
if (guildMembersIntentEnabled) {
  client.on('guildMemberAdd', async (member) => {
    // Only add the server if the user is a registered Discross user
    const user = auth.dbQuerySingle('SELECT discordID FROM users WHERE discordID=?', [member.user.id]);
    if (user) {
      auth.insertServers([{ serverID: member.guild.id, discordID: member.user.id, icon: member.guild.icon }]);
    }
  });

  client.on('guildMemberRemove', async (member) => {
    auth.dbQueryRun('DELETE FROM servers WHERE serverID=? AND discordID=?', [member.guild.id, member.user.id]);
  });
}

exports.startBot = async function () {
  if (process.env.TOKEN) {
    client.login(process.env.TOKEN)
  } else {
    console.error('No token found! Please set the TOKEN environment variable to your bot token.')
    process.exit(1)
  }
}

exports.addToCache = function (msg) {
  if (msghistory[msg.channel.id]) {
    msghistory[msg.channel.id].set(msg.id, msg)
  }
}

exports.getHistoryCached = async function (chnl) {
  if (!chnl.id) {
    chnl = client.channels.get(chnl)
  }
  if (!msghistory[chnl.id]) {
    // Fetch messages - Discord.js will try to populate member data automatically if available in cache
    const messagearray = await chnl.messages.fetch({ limit: cachelength })
    msghistory[chnl.id] = messagearray.sort((messageA, messageB) => messageA.createdTimestamp - messageB.createdTimestamp)
  }
  return Array.from(msghistory[chnl.id].values())
}

exports.client = client

