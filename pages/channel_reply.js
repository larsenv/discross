'use strict';
const fs = require('fs');
const { PermissionFlagsBits } = require('discord.js');
const { getDisplayName } = require('./memberUtils');
const { getClientIP, getTimezoneFromIP, formatDateWithTimezone } = require('../timezoneUtils');
const { buildMessagesHtml } = require('./channel');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const notFound = require('./notFound.js');
const {
  strReplace,
  isBotReady,
  parseCookies,
  resolveTheme,
  RANDOM_EMOJIS,
  buildSessionParam,
} = require('./utils.js');

// Templates for viewing messages in a channel (Reply Context)
const channel_reply_bar_template = fs.readFileSync(
  'pages/templates/partials/channel_reply_bar.html',
  'utf-8'
);
const channel_template = fs
  .readFileSync('pages/templates/channel.html', 'utf-8')
  .split('{$COMMON_HEAD}')
  .join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'))
  .split('{$PAGE_CLASS}')
  .join('page-channel-reply')
  .split('{$CONTENT_EXTRA_PADDING}')
  .join(' padding-bottom: 190px;')
  .split('{$EMOJI_PICKER}')
  .join(fs.readFileSync('pages/templates/partials/emoji_picker.html', 'utf-8'))
  .split('{$EMOJI_BUTTON}')
  .join(fs.readFileSync('pages/templates/partials/emoji_picker_button.html', 'utf-8'))
  .split('{$REPLY_MESSAGE_ID_INPUT}')
  .join('<input type="hidden" name="reply_message_id" value="{$REPLY_MESSAGE_ID}">');

// Reply-specific message wrapper templates
const message_template = fs.readFileSync('pages/templates/message/message_reply.html', 'utf-8');
const message_forwarded_template = fs.readFileSync(
  'pages/templates/message/forwarded_message_reply.html',
  'utf-8'
);
const message_mentioned_template = fs.readFileSync(
  'pages/templates/message/message_reply_mentioned.html',
  'utf-8'
);
const message_forwarded_mentioned_template = fs.readFileSync(
  'pages/templates/message/forwarded_message_reply_mentioned.html',
  'utf-8'
);

// Shared templates (same as channel.js)
const first_message_content_template = fs.readFileSync(
  'pages/templates/message/first_message_content.html',
  'utf-8'
);
const merged_message_content_template = fs.readFileSync(
  'pages/templates/message/merged_message_content.html',
  'utf-8'
);
const mention_template = fs.readFileSync('pages/templates/message/mention.html', 'utf-8');
const input_template = fs.readFileSync('pages/templates/channel/input.html', 'utf-8');
const input_disabled_template = fs.readFileSync(
  'pages/templates/channel/input_disabled.html',
  'utf-8'
);
const no_message_history_template = fs.readFileSync(
  'pages/templates/channel/no_message_history.html',
  'utf-8'
);
const file_download_template = fs.readFileSync(
  'pages/templates/channel/file_download.html',
  'utf-8'
);
const reactions_template = fs.readFileSync('pages/templates/message/reactions.html', 'utf-8');
const reaction_template = fs.readFileSync('pages/templates/message/reaction.html', 'utf-8');
const date_separator_template = fs.readFileSync(
  'pages/templates/message/date_separator.html',
  'utf-8'
);

exports.processChannelReply = async function processChannelReply(bot, req, res, args, discordID) {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
  const urlTheme = parsedUrl.searchParams.get('theme');
  const urlImages = parsedUrl.searchParams.get('images');

  const { whiteThemeCookie, images: imagesCookieValue } = parseCookies(req);

  // Build combined URL params for links — only include preference params when the
  // corresponding cookie is absent (i.e. the browser doesn't support cookies)
  const sessionParam = buildSessionParam(
    urlSessionID,
    urlTheme,
    whiteThemeCookie,
    urlImages,
    imagesCookieValue
  );

  const themeObj = resolveTheme(req);
  const { authorText, replyText, themeClass, boxColor } = themeObj;
  const baseTemplate = strReplace(channel_template, '{$WHITE_THEME_ENABLED}', themeClass);

  const imagesCookie =
    urlImages !== null
      ? parseInt(urlImages, 10)
      : imagesCookieValue !== undefined
        ? parseInt(imagesCookieValue, 10)
        : 1;

  const clientIP = getClientIP(req);
  const clientTimezone = getTimezoneFromIP(clientIP);

  try {
    if (!isBotReady(bot)) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end("The bot isn't connected, try again in a moment");
      return;
    }

    const chnl = await bot.client.channels.fetch(args[2]).catch(() => undefined);

    if (chnl) {
      const botMember = await chnl.guild.members.fetch(bot.client.user.id).catch(() => null);
      if (!botMember) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('The bot is not in this server!');
        return;
      }

      const member = await chnl.guild.members.fetch(discordID).catch(() => null);
      if (!member) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('You are not in this server! Please join the server to view this channel.');
        return;
      }

      if (
        !member.permissionsIn(chnl).has(PermissionFlagsBits.ViewChannel, true) ||
        !botMember.permissionsIn(chnl).has(PermissionFlagsBits.ViewChannel, true)
      ) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end("You (or the bot) don't have permission to do that!");
        return;
      }

      if (!member.permissionsIn(chnl).has(PermissionFlagsBits.ReadMessageHistory, true)) {
        const withServerId = strReplace(baseTemplate, '{$SERVER_ID}', chnl.guild.id);
        const withChannelId = strReplace(withServerId, '{$CHANNEL_ID}', chnl.id);
        const withChannelReply = strReplace(withChannelId, '{$CHANNEL_REPLY}', '');

        const inputTpl = member.permissionsIn(chnl).has(PermissionFlagsBits.SendMessages, true)
          ? input_template
          : input_disabled_template;
        const withInput = strReplace(withChannelReply, '{$INPUT}', inputTpl);
        const withColor = strReplace(withInput, '{$COLOR}', boxColor);
        const withMessages = strReplace(withColor, '{$MESSAGES}', no_message_history_template);
        const withSessionId = strReplace(withMessages, '{$SESSION_ID}', urlSessionID);
        const final = strReplace(withSessionId, '{$SESSION_PARAM}', sessionParam);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(final);
        return;
      }

      const response = await buildMessagesHtml({
        bot,
        chnl,
        member,
        discordID,
        req,
        imagesCookie,
        authorText,
        replyText,
        clientTimezone,
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
        },
      });

      const withServerId = strReplace(baseTemplate, '{$SERVER_ID}', chnl.guild.id);
      const withChannelId = strReplace(withServerId, '{$CHANNEL_ID}', chnl.id);
      const template = strReplace(
        withChannelId,
        '{$REFRESH_URL}',
        chnl.id +
          '?random=' +
          Math.random() +
          (urlSessionID ? '&sessionID=' + encodeURIComponent(urlSessionID) : '')
      );

      const noWebhooks = !botMember
        .permissionsIn(chnl)
        .has(PermissionFlagsBits.ManageWebhooks, true);
      const canSend = member.permissionsIn(chnl).has(PermissionFlagsBits.SendMessages, true);
      const inputTpl = noWebhooks || !canSend ? input_disabled_template : input_template;
      const withInputAndColor = strReplace(
        strReplace(template, '{$INPUT}', inputTpl),
        '{$COLOR}',
        boxColor
      );
      const afterWebhookCheck = noWebhooks
        ? strReplace(
            withInputAndColor,
            "You don't have permission to send messages in this channel.",
            "Discross bot doesn't have the Manage Webhooks permission"
          )
        : withInputAndColor;

      // Reply context: fetch and display the message being replied to
      const reply_message_id = args[3];
      try {
        const message = await chnl.messages.fetch(reply_message_id);
        const message_content =
          message.content.length > 30 ? message.content.substring(0, 30) + '...' : message.content;

        const author = await chnl.guild.members
          .fetch(message.author.id)
          .then((replyMember) => getDisplayName(replyMember, message.author))
          .catch(() => getDisplayName(null, message.author));

        const randomEmoji = RANDOM_EMOJIS[Math.floor(Math.random() * RANDOM_EMOJIS.length)];
        const replyBar = strReplace(
          strReplace(channel_reply_bar_template, '{$REPLY_MESSAGE_AUTHOR}', author),
          '{$REPLY_MESSAGE_CONTENT}',
          message_content
        );
        const withChannelReply = strReplace(afterWebhookCheck, '{$CHANNEL_REPLY}', replyBar);
        const withReplyId = strReplace(withChannelReply, '{$REPLY_MESSAGE_ID}', reply_message_id);
        const withEmoji = strReplace(withReplyId, '{$RANDOM_EMOJI}', randomEmoji);
        const withChannelName = strReplace(
          withEmoji,
          '{$CHANNEL_NAME}',
          normalizeWeirdUnicode(chnl.name)
        );
        const withMessages = strReplace(withChannelName, '{$MESSAGES}', response);
        const withSessionId = strReplace(withMessages, '{$SESSION_ID}', urlSessionID);
        const final = strReplace(withSessionId, '{$SESSION_PARAM}', sessionParam);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(final);
      } catch (err) {
        return notFound.serve404(req, res, 'Invalid message to reply to.', '/', 'Back to Home');
      }
    } else {
      return notFound.serve404(req, res, 'Invalid channel.', '/', 'Back to Home');
    }
  } catch (error) {
    console.error(error);
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end('An error occurred! Please try again later.');
  }
};
