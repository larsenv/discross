const fs = require('fs')
const Discord = require('discord.js')

const auth = require('./authentication.js')
const connectionHandler = require('./connectionHandler.js')

const cachelength = 100 // Length of message history
const msghistory = {}
const client = new Discord.Client({ partials: [Discord.Partials.Message], shards: "auto", intents: [Discord.GatewayIntentBits.Guilds/*, Discord.GatewayIntentBits.GuildMembers*/, Discord.GatewayIntentBits.GuildMessages, Discord.GatewayIntentBits.MessageContent] })

// https://stackoverflow.com/questions/1967119/why-does-javascript-replace-only-first-instance-when-using-replace

client.on('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}!`)
  // console.log(client.channels.array());
})

client.on('messageCreate', async function (msg) {
  if (msghistory[msg.channel.id] && !(msghistory[msg.channel.id].get(msg.id))) {
    msghistory[msg.channel.id].set(msg.id, msg)

    if (msghistory[msg.channel.id].length > cachelength) {
      msghistory[msg.channel.id] = msghistory[msg.channel.id].slice(msghistory[msg.channel.id].length - (cachelength + 1), msghistory[msg.channel.id].length) // Limit the length of the cache to 50 messages
    }
  }

  // console.log(msghistory[msg.channel.id.toString()].length);
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

// client.on('messageDelete

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
