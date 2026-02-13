const { processChannelView } = require('./channelProcessor');

exports.processChannelReply = async function processChannelReply(bot, req, res, args, discordID) {
  await processChannelView(bot, req, res, args, discordID, {
    channelTemplate: 'pages/templates/channel_reply.html',
    messageTemplate: 'pages/templates/message/message_reply.html',
    messageForwardedTemplate: 'pages/templates/message/forwarded_message_reply.html',
    messageMentionedTemplate: 'pages/templates/message/message_reply_mentioned.html',
    messageForwardedMentionedTemplate: 'pages/templates/message/forwarded_message_reply_mentioned.html',
    isReplyContext: true,
    errorHandling: 'redirect',
    postProcessFinal: async (final, response, { chnl, args, getDisplayName, strReplace, fetch }) => {
      // --- Reply Context Logic (Specific to this function) ---
      let reply_message_id = args[3];

      try {
        let message = await chnl.messages.fetch(reply_message_id);
        let message_content = message.content;
        if (message_content.length > 30) {
          message_content = message.content.substring(0, 30) + "...";
        }
        
        // Get proper display name for the reply author
        let author;
        try {
          const replyMember = await chnl.guild.members.fetch(message.author.id);
          author = getDisplayName(replyMember, message.author);
        } catch {
          // If we can't fetch the member, use the author's display name
          author = getDisplayName(null, message.author);
        }
        
        final = strReplace(final, "{$REPLY_MESSAGE_ID}", reply_message_id);
        final = strReplace(final, "{$REPLY_MESSAGE_AUTHOR}", author);
        final = strReplace(final, "{$REPLY_MESSAGE_CONTENT}", message_content);
        
        return { final, response };
      } catch (err) {
        // Return null to signal error, which will be handled by channelProcessor
        return null;
      }
    },
    postProcessResponse: async (response, { fetch }) => {
      // Process Tenor links
      const tensorLinksRegex = /<a href="https:\/\/tenor\.com\/view\/([A-Za-z0-9]+(-[A-Za-z0-9]+)+)">https:\/\/tenor\.com\/view\/([A-Za-z0-9]+(-[A-Za-z0-9]+)+)<\/a>/g;
      let tmpTensorLinks = [...response.toString().matchAll(tensorLinksRegex)];
      let resp_,gifLink,description;
      tmpTensorLinks.forEach(link => {
        resp_ = fetch("https://g.tenor.com/v1/gifs?ids=" + link[0].toString().split("-").at(-1).replace(/<\/a>/, "") + "&key=LIVDSRZULELA");
        try { 
          resp_ = resp_.json();
          gifLink = resp_["results"][0]["media"][0]["tinygif"]["url"];
          description = resp_["results"][0]["content_description"];
        } catch (err) { 
          console.error("Error processing Tenor link:", err);
          return;
        }
        response = response.replace(link[0], "<img src=\"" + gifLink + "\" alt=\"" + description + "\">");
      });
      return response;
    }
  });
};
