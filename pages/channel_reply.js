var fs = require('fs');
const { PermissionFlagsBits } = require('discord.js');
const { getDisplayName } = require('./memberUtils');
const { getClientIP, getTimezoneFromIP, formatDateWithTimezone } = require('../timezoneUtils');
const { buildMessagesHtml } = require('./channel');
const { normalizeWeirdUnicode } = require('./unicodeUtils');

// Templates for viewing messages in a channel (Reply Context)
const channel_template = fs.readFileSync('pages/templates/channel_reply.html', 'utf-8').split('{$COMMON_HEAD}').join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));

// Reply-specific message wrapper templates
const message_template = fs.readFileSync('pages/templates/message/message_reply.html', 'utf-8');
const message_forwarded_template = fs.readFileSync('pages/templates/message/forwarded_message_reply.html', 'utf-8');
const message_mentioned_template = fs.readFileSync('pages/templates/message/message_reply_mentioned.html', 'utf-8');
const message_forwarded_mentioned_template = fs.readFileSync('pages/templates/message/forwarded_message_reply_mentioned.html', 'utf-8');

// Shared templates (same as channel.js)
const first_message_content_template = fs.readFileSync('pages/templates/message/first_message_content.html', 'utf-8');
const merged_message_content_template = fs.readFileSync('pages/templates/message/merged_message_content.html', 'utf-8');
const mention_template = fs.readFileSync('pages/templates/message/mention.html', 'utf-8');
const input_template = fs.readFileSync('pages/templates/channel/input.html', 'utf-8');
const input_disabled_template = fs.readFileSync('pages/templates/channel/input_disabled.html', 'utf-8');
const no_message_history_template = fs.readFileSync('pages/templates/channel/no_message_history.html', 'utf-8');
const file_download_template = fs.readFileSync('pages/templates/channel/file_download.html', 'utf-8');
const reactions_template = fs.readFileSync('pages/templates/message/reactions.html', 'utf-8');
const reaction_template = fs.readFileSync('pages/templates/message/reaction.html', 'utf-8');
const date_separator_template = fs.readFileSync('pages/templates/message/date_separator.html', 'utf-8');

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || "");
}

exports.processChannelReply = async function processChannelReply(bot, req, res, args, discordID) {
  const whiteThemeCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('whiteThemeCookie='))?.split('=')[1];
  const urlSessionID = new URL(req.url, 'http://localhost').searchParams.get('sessionID') || '';
  const sessionParam = urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '';

  let boxColor;
  let authorText;
  let replyText;
  let template;

  boxColor = "#40444b";
  authorText = "#72767d";
  replyText = "#b5bac1";

  if (whiteThemeCookie == 1) {
    boxColor = "#ffffff";
    authorText = "#000000";
    replyText = "#000000";
    template = strReplace(channel_template, "{$WHITE_THEME_ENABLED}", "class=\"light-theme\"");
  } else if (whiteThemeCookie == 2) {
    boxColor = "#40444b";
    authorText = "#72767d";
    replyText = "#b5bac1";
    template = strReplace(channel_template, "{$WHITE_THEME_ENABLED}", "class=\"amoled-theme\"");
  } else {
    template = strReplace(channel_template, "{$WHITE_THEME_ENABLED}", "");
  }

  const imagesCookieValue = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('images='))?.split('=')[1];
  const imagesCookie = imagesCookieValue !== undefined ? parseInt(imagesCookieValue) : 1;

  const animationsCookieValue = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('animations='))?.split('=')[1];
  const animationsCookie = animationsCookieValue !== undefined ? parseInt(animationsCookieValue) : 1;

  const clientIP = getClientIP(req);
  const clientTimezone = getTimezoneFromIP(clientIP);

  try {
    const clientIsReady = bot && bot.client && (typeof bot.client.isReady === 'function' ? bot.client.isReady() : !!bot.client.uptime);

    if (!clientIsReady) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.write("The bot isn't connected, try again in a moment");
      res.end();
      return;
    }

    let chnl;
    try {
      chnl = await bot.client.channels.fetch(args[2]);
    } catch (err) {
      chnl = undefined;
    }

    if (chnl) {
      let botMember, member;
      try {
        botMember = await chnl.guild.members.fetch(bot.client.user.id);
      } catch (err) {
        res.write("The bot is not in this server!");
        res.end();
        return;
      }

      try {
        member = await chnl.guild.members.fetch(discordID);
      } catch (err) {
        res.write("You are not in this server! Please join the server to view this channel.");
        res.end();
        return;
      }

      if (!member.permissionsIn(chnl).has(PermissionFlagsBits.ViewChannel, true) || !botMember.permissionsIn(chnl).has(PermissionFlagsBits.ViewChannel, true)) {
        res.write("You (or the bot) don't have permission to do that!");
        res.end();
        return;
      }

      if (!member.permissionsIn(chnl).has(PermissionFlagsBits.ReadMessageHistory, true)) {
        template = strReplace(template, "{$SERVER_ID}", chnl.guild.id);
        template = strReplace(template, "{$CHANNEL_ID}", chnl.id);

        let final;
        if (member.permissionsIn(chnl).has(PermissionFlagsBits.SendMessages, true)) {
          final = strReplace(template, "{$INPUT}", input_template);
        } else {
          final = strReplace(template, "{$INPUT}", input_disabled_template);
        }
        final = strReplace(final, "{$COLOR}", boxColor);
        final = strReplace(final, "{$MESSAGES}", no_message_history_template);
        final = strReplace(final, "{$SESSION_ID}", urlSessionID);
        final = strReplace(final, "{$SESSION_PARAM}", sessionParam);

        res.write(final);
        res.end();
        return;
      }

      console.log("Processed valid channel reply request");
      const response = await buildMessagesHtml({
        bot, chnl, member, discordID, req,
        imagesCookie, animationsCookie,
        authorText, replyText, clientTimezone,
        channelId: null, // no reply links in reply context
        templates: {
          message: message_template,
          message_forwarded: message_forwarded_template,
          message_mentioned: message_mentioned_template,
          message_forwarded_mentioned: message_forwarded_mentioned_template,
          first_message_content: first_message_content_template,
          merged_message_content: merged_message_content_template,
          mention: mention_template,
          file_download: file_download_template,
          reactions: reactions_template,
          reaction: reaction_template,
          date_separator: date_separator_template,
        }
      });

      template = strReplace(template, "{$SERVER_ID}", chnl.guild.id);
      template = strReplace(template, "{$CHANNEL_ID}", chnl.id);
      template = strReplace(template, "{$REFRESH_URL}", chnl.id + "?random=" + Math.random() + (urlSessionID ? '&sessionID=' + encodeURIComponent(urlSessionID) : ''));

      let final;
      if (!botMember.permissionsIn(chnl).has(PermissionFlagsBits.ManageWebhooks, true)) {
        final = strReplace(template, "{$INPUT}", input_disabled_template);
        final = strReplace(final, "{$COLOR}", boxColor);
        final = strReplace(final, "You don't have permission to send messages in this channel.", "Discross bot doesn't have the Manage Webhooks permission");
      } else if (member.permissionsIn(chnl).has(PermissionFlagsBits.SendMessages, true)) {
        final = strReplace(template, "{$INPUT}", input_template);
        final = strReplace(final, "{$COLOR}", boxColor);
      } else {
        final = strReplace(template, "{$INPUT}", input_disabled_template);
        final = strReplace(final, "{$COLOR}", boxColor);
      }

      // Reply context: fetch and display the message being replied to
      const reply_message_id = args[3];
      try {
        let message = await chnl.messages.fetch(reply_message_id);
        let message_content = message.content;
        if (message_content.length > 30) {
          message_content = message.content.substring(0, 30) + "...";
        }

        let author;
        try {
          const replyMember = await chnl.guild.members.fetch(message.author.id);
          author = getDisplayName(replyMember, message.author);
        } catch {
          author = getDisplayName(null, message.author);
        }

        final = strReplace(final, "{$REPLY_MESSAGE_ID}", reply_message_id);
        final = strReplace(final, "{$REPLY_MESSAGE_AUTHOR}", author);
        final = strReplace(final, "{$REPLY_MESSAGE_CONTENT}", message_content);
      } catch (err) {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.write("Invalid message to reply to!");
        res.end();
        return;
      }

      const randomEmoji = ["1f62d", "1f480", "2764-fe0f", "1f44d", "1f64f", "1f389", "1f642"][Math.floor(Math.random() * 7)];
      final = strReplace(final, "{$RANDOM_EMOJI}", randomEmoji);
      final = strReplace(final, "{$CHANNEL_NAME}", normalizeWeirdUnicode(chnl.name));
      final = strReplace(final, "{$MESSAGES}", response);
      final = strReplace(final, "{$SESSION_ID}", urlSessionID);
      final = strReplace(final, "{$SESSION_PARAM}", sessionParam);

      res.writeHead(200, { "Content-Type": "text/html" });
      res.write(final);
      res.end();
    } else {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.write("Invalid channel!");
      res.end();
    }
  } catch (error) {
    console.log(error);
    res.writeHead(500, { "Content-Type": "text/html" });
    res.write("An error occurred! Please try again later.");
    res.end();
  }
}
