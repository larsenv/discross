const fs = require('fs');
const { processChannelView } = require('./channelProcessor');

function readTemplate(filePath) {
  let content = fs.readFileSync(filePath, 'utf-8');
  // Remove #end if it appears right before a closing quote in an href
  content = content.replace(/#end(?=["'])/g, ""); 
  return content;
}

exports.processChannel = async function processChannel(bot, req, res, args, discordID) {
  await processChannelView(bot, req, res, args, discordID, {
    channelTemplate: 'pages/templates/channel.html',
    messageTemplate: 'pages/templates/message/message.html',
    messageForwardedTemplate: 'pages/templates/message/forwarded_message.html',
    messageMentionedTemplate: 'pages/templates/message/message_mentioned.html',
    messageForwardedMentionedTemplate: 'pages/templates/message/forwarded_message_mentioned.html',
    readTemplate: readTemplate,
    isReplyContext: false,
    errorHandling: 'error-page'
  });
};
