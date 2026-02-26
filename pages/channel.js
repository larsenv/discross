var fs = require('fs');
var escape = require('escape-html');
var he = require('he');
const path = require('path');
const url = require('url');
const sharp = require("sharp");
const emojiRegex = require("./twemojiRegex").regex;
const sanitizer = require("path-sanitizer").default;
const { PermissionFlagsBits, MessageReferenceType } = require('discord.js');
const { channel } = require('diagnostics_channel');
const fetch = require("sync-fetch");
const { renderDiscordMarkdown } = require('./discordMarkdown');
const { getDisplayName, getMemberColor, ensureMemberData } = require('./memberUtils');
const { getClientIP, getTimezoneFromIP, formatDateWithTimezone, formatDateSeparator, areDifferentDays } = require('../timezoneUtils');
const { processEmbeds } = require('./embedUtils');
const { processReactions } = require('./reactionUtils');
const { processPoll } = require('./pollUtils');
const { isEmojiOnlyMessage } = require('./messageUtils');
const { normalizeWeirdUnicode } = require('./unicodeUtils');

function readTemplate(filePath) {
  let content = fs.readFileSync(filePath, 'utf-8');
  // Remove #end if it appears right before a closing quote in an href
  content = content.replace(/#end(?=["'])/g, ""); 
  return content;
}

const message_template = readTemplate('pages/templates/message/message.html');
const message_forwarded_template = readTemplate('pages/templates/message/forwarded_message.html');
const message_mentioned_template = readTemplate('pages/templates/message/message_mentioned.html');
const message_forwarded_mentioned_template = readTemplate('pages/templates/message/forwarded_message_mentioned.html');
const channel_template = fs.readFileSync('pages/templates/channel.html', 'utf-8');
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
// Constants
const FORWARDED_CONTENT_MAX_LENGTH = 100;

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || "");
};

function formatFileSize(bytes) {
  if (bytes === 0) return '0.00 Bytes';
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const formattedSize = (bytes / Math.pow(1024, i)).toFixed(2);
  return `${formattedSize} ${sizes[i]}`;
}

// Remove any existing anchors with id or name 'end' from HTML
function removeExistingEndAnchors(html) {
  // Remove anchors that have id="end" or name="end" (handles both single and double quotes)
  return html.replace(/<a[^>]*(?:id=['"]end['"]|name=['"]end['"])[^>]*>[\s\S]*?<\/a>/gi, '');
}

// Check if a URL's hostname matches a given domain (or is a subdomain of it)
function urlMatchesDomain(url, domain) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === domain || parsed.hostname.endsWith('.' + domain);
  } catch {
    return false;
  }
}

// Member utility functions (getDisplayName, getMemberColor, ensureMemberData) 
// are now imported from memberUtils.js to avoid duplication

// https://stackoverflow.com/questions/1967119/why-does-javascript-replace-only-first-instance-when-using-replace

/**
 * Build the HTML for all messages in a channel.
 * This shared function is used by both processChannel and processChannelReply.
 *
 * @param {Object} params
 * @returns {Promise<string>} Complete messages HTML including end anchor
 */
exports.buildMessagesHtml = async function buildMessagesHtml(params) {
  const {
    bot, chnl, member, discordID, req,
    imagesCookie, animationsCookie,
    authorText, replyText, clientTimezone,
    channelId, // for {$MESSAGE_REPLY_LINK}; pass null to skip
    templates: {
      message: tmpl_message,
      message_forwarded: tmpl_message_forwarded,
      message_mentioned: tmpl_message_mentioned,
      message_forwarded_mentioned: tmpl_message_forwarded_mentioned,
      first_message_content: tmpl_first_message_content,
      merged_message_content: tmpl_merged_message_content,
      mention: tmpl_mention,
      file_download: tmpl_file_download,
      reactions: tmpl_reactions,
      reaction: tmpl_reaction,
      date_separator: tmpl_date_separator,
    }
  } = params;

  let response = "";
  const messages = await bot.getHistoryCached(chnl);
  let lastauthor = undefined;
  let lastmember = undefined;
  let lastdate = new Date('1995-12-17T03:24:00');
  let lastmessagedate = null;
  let currentmessage = "";
  let islastmessage = false;
  let messageid = 0;
  let isForwarded = false;
  let forwardData = {};
  let isMentioned = false;
  let isReply = false;
  let replyData = {};
  let lastMentioned = false;
  let lastReply = false;
  let lastReplyData = {};

  const memberCache = new Map();

  const isSameUser = (member1, author1, member2, author2) => {
    if (member1 && member2) {
      return member1.user.id === member2.user.id;
    }
    return author1.id === author2.id && author1.username === author2.username;
  };

  const handlemessage = async function (item) {
    if (lastauthor) {
      if (islastmessage || (item && (!isSameUser(lastmember, lastauthor, null, item.author) || item.createdAt - lastdate > 420000))) {

        if (isForwarded && lastMentioned) {
          currentmessage = tmpl_message_forwarded_mentioned.replace("{$MESSAGE_CONTENT}", currentmessage);
          currentmessage = currentmessage.replace("{$FORWARDED_AUTHOR}", escape(forwardData.author));
          currentmessage = currentmessage.replace("{$FORWARDED_CONTENT}", forwardData.content);
          currentmessage = currentmessage.replace("{$FORWARDED_DATE}", forwardData.date);
        } else if (isForwarded) {
          currentmessage = tmpl_message_forwarded.replace("{$MESSAGE_CONTENT}", currentmessage);
          currentmessage = currentmessage.replace("{$FORWARDED_AUTHOR}", escape(forwardData.author));
          currentmessage = currentmessage.replace("{$FORWARDED_CONTENT}", forwardData.content);
          currentmessage = currentmessage.replace("{$FORWARDED_DATE}", forwardData.date);
        } else if (lastMentioned) {
          currentmessage = tmpl_message_mentioned.replace("{$MESSAGE_CONTENT}", currentmessage);
          if (channelId) currentmessage = currentmessage.replace("{$MESSAGE_REPLY_LINK}", "/channels/" + channelId + "/" + messageid);
        } else {
          currentmessage = tmpl_message.replace("{$MESSAGE_CONTENT}", currentmessage);
          if (channelId) currentmessage = currentmessage.replace("{$MESSAGE_REPLY_LINK}", "/channels/" + channelId + "/" + messageid);
        }

        const displayName = getDisplayName(lastmember, lastauthor);
        const authorColor = getMemberColor(lastmember, authorText);

        currentmessage = currentmessage.replace("{$MESSAGE_AUTHOR}", escape(displayName));
        currentmessage = strReplace(currentmessage, "{$AUTHOR_COLOR}", authorColor);

        let replyIndicator = '';
        if (lastReply) {
          const contentPreview = lastReplyData.content ? `<br><font style="font-size:12px;color:`+authorText+`" face="rodin,sans-serif">${escape(lastReplyData.content)}</font>` : '';
          replyIndicator = '<table cellpadding="0" cellspacing="0" style="margin-bottom:4px"><tr>' +
            '<td style="width:2px;height:10px;background-color:#4e5058;border-radius:2px 0 0 2px;vertical-align:top"></td>' +
            '<td style="width:12px;height:10px;vertical-align:bottom"><div style="height:2px;background-color:#4e5058;border-radius:0 0 0 2px"></div></td>' +
            '<td style="padding-left:4px"><font style="font-size:12px;color:'+replyText+'" face="rodin,sans-serif">Replying to @' + escape(lastReplyData.author) + contentPreview + '</font></td>' +
            '</tr></table>';
        }
        currentmessage = strReplace(currentmessage, "{$REPLY_INDICATOR}", replyIndicator);
        currentmessage = strReplace(currentmessage, "{$PING_INDICATOR}", '');

        currentmessage = strReplace(currentmessage, "{$MESSAGE_DATE}", formatDateWithTimezone(lastdate, clientTimezone));
        currentmessage = strReplace(currentmessage, "{$TAG}", he.encode(JSON.stringify("<@" + lastauthor.id + ">")));
        response += currentmessage;
        currentmessage = "";
      }
    }

    if (!item) {
      return;
    }

    let currentMember = null;
    if (item.member) {
      currentMember = item.member;
    } else if (item.webhookId) {
      currentMember = await ensureMemberData(item, chnl.guild, memberCache);
    }

    if (clientTimezone && areDifferentDays(item.createdAt, lastmessagedate, clientTimezone)) {
      const separatorText = formatDateSeparator(item.createdAt, clientTimezone);
      const separator = tmpl_date_separator.replace("{$DATE_SEPARATOR}", separatorText);
      response += separator;
    }

    lastmessagedate = item.createdAt;

    isForwarded = false;
    forwardData = {};
    if (item.reference?.type === MessageReferenceType.Forward) {
      try {
        const forwardedMessage = await item.fetchReference();
        const forwardedMember = forwardedMessage.member;
        const forwardedAuthor = getDisplayName(forwardedMember, forwardedMessage.author);
        const forwardedContent = forwardedMessage.content.length > FORWARDED_CONTENT_MAX_LENGTH
          ? forwardedMessage.content.substring(0, FORWARDED_CONTENT_MAX_LENGTH) + "..."
          : forwardedMessage.content;
        const forwardedDate = formatDateWithTimezone(forwardedMessage.createdAt, clientTimezone);

        isForwarded = true;
        forwardData = {
          author: forwardedAuthor,
          content: renderDiscordMarkdown(forwardedContent),
          date: forwardedDate
        };
      } catch (err) {
        isForwarded = false;
      }
    }

    isReply = false;
    replyData = {};
    if (item.reference && !isForwarded) {
      try {
        let replyUser = item.mentions?.repliedUser;
        let replyMember = undefined;
        let replyMessage = undefined;

        try {
          replyMessage = await item.fetchReference();
          replyUser = replyMessage.author;
        } catch (err) {
          // Message was likely deleted or is inaccessible.
        }

        if (replyMessage && replyMessage.member) {
          replyMember = replyMessage.member;
        }

        const replyAuthor = getDisplayName(replyMember, replyUser);
        const mentionsRepliedUser = item.mentions?.repliedUser != null;

        let replyContent = '';
        if (replyMessage && replyMessage.content) {
          const maxLength = 50;
          replyContent = replyMessage.content.length > maxLength
            ? replyMessage.content.substring(0, maxLength) + '...'
            : replyMessage.content;
        }

        isReply = true;
        replyData = {
          author: replyAuthor,
          authorId: replyUser?.id,
          mentionsPing: mentionsRepliedUser,
          content: replyContent
        };
      } catch (err) {
        console.error("Could not process reply data:", err);
        isReply = false;
      }
    }

    let messagetext = renderDiscordMarkdown(item.content);

    let isJumbo = false;
    if (imagesCookie === 1) {
      const customEmojiRegex = /<a?:.+?:\d{17,19}>/g;
      const customMatches = item.content.match(customEmojiRegex) || [];
      const unicodeMatches = item.content.match(emojiRegex) || [];
      const totalEmojis = customMatches.length + unicodeMatches.length;
      const strippedContent = item.content.replace(customEmojiRegex, '').replace(emojiRegex, '').trim();
      if (strippedContent.length === 0 && totalEmojis > 0 && totalEmojis <= 29) {
        isJumbo = true;
      }
    }

    const emojiSize = isJumbo ? "2.75em" : "1.375em";
    const emojiPxSize = isJumbo ? 44 : 22;

    if (imagesCookie === 1) {
      if (messagetext.match(emojiRegex)) {
        const unicode_emoji_matches = [...messagetext.match(emojiRegex)];
        unicode_emoji_matches.forEach(match => {
          const points = [];
          let char = 0;
          let previous = 0;
          let i = 0;
          let output;
          while (i < match.length) {
            char = match.charCodeAt(i++);
            if (previous) {
              points.push((0x10000 + ((previous - 0xd800) << 10) + (char - 0xdc00)).toString(16));
              previous = 0;
            } else if (char > 0xd800 && char <= 0xdbff) {
              previous = char;
            } else {
              points.push(char.toString(16));
            }
            output = points.join("-");
          }
          const emojiExt = animationsCookie === 1 ? 'gif' : 'png';
          messagetext = messagetext.replace(match, `<img src="/resources/twemoji/${output}.${emojiExt}" width="${emojiPxSize}" height="${emojiPxSize}" style="width: ${emojiSize}; height: ${emojiSize}; vertical-align: -0.2em;" alt="emoji" onerror="this.style.display='none'">`);
        });
      }

      const custom_emoji_matches = [...messagetext.matchAll(/&lt;(:)?(?:(a):)?(\w{2,32}):(\d{17,19})?(?:(?!\1).)*&gt;/g)];
      if (custom_emoji_matches.length > 0) {
        custom_emoji_matches.forEach(match => {
          const ext = match[2] ? "gif" : "png";
          messagetext = messagetext.replace(match[0], `<img src="/imageProxy/emoji/${match[4]}.${ext}" width="${emojiPxSize}" height="${emojiPxSize}" style="width: ${emojiSize}; height: ${emojiSize}; vertical-align: -0.2em;" alt="emoji" onerror="this.style.display='none'">`);
        });
      }
    }

    if (item?.attachments) {
      let urls = new Array();
      item.attachments.forEach(attachment => {
        let url;
        if (attachment.name.match?.(/(?:\.(jpg|gif|png|jpeg|avif|gif|svg|webp|tif|tiff))$/) && imagesCookie == 1) {
          url = "/imageProxy/".concat(attachment.url.replace(/^(.*?)(\d+)/, '$2'));
        } else if (attachment.name.match?.(/(?:\.(mp4|webm|mov|avi|mkv))$/) && imagesCookie == 1) {
          url = "/fileProxy/".concat(attachment.url.replace(/^(.*?)(\d+)/, '$2'));
          messagetext = messagetext.concat(tmpl_file_download);
          messagetext = messagetext.replace('{$FILE_NAME}', attachment.name.length > 30 ? attachment.name.replace(/(.*\.)(.*)$/, "$1").slice(0, 25) + "..." + attachment.name.replace(/(.*\.)(.*)$/, "$2") : attachment.name);
          messagetext = messagetext.replace('{$FILE_SIZE}', formatFileSize(attachment.size));
          urls.push(url);
          return;
        } else {
          url = "/fileProxy/".concat(attachment.url.replace(/^(.*?)(\d+)/, '$2'));
          messagetext = messagetext.concat(tmpl_file_download);
          messagetext = messagetext.replace('{$FILE_NAME}', attachment.name.length > 30 ? attachment.name.replace(/(.*\.)(.*)$/, "$1").slice(0, 25) + "..." + attachment.name.replace(/(.*\.)(.*)$/, "$2") : attachment.name);
          messagetext = messagetext.replace('{$FILE_SIZE}', formatFileSize(attachment.size));
        }
        urls.push(url);
      });
      urls.forEach(url => {
        url.match?.(/(?:\.(jpg|gif|png|jpeg|avif|gif|svg|webp|tif|tiff))/) && imagesCookie == 1 ? messagetext = messagetext.concat(`<br><a href="${url}" target="_blank"><img src="${url}" style="max-width:256px;max-height:200px;width:auto;height:auto;" alt="image"></a>`) : messagetext = messagetext.replace('{$FILE_LINK}', url);
      });
    }

    if (item.stickers && item.stickers.size > 0) {
      if (imagesCookie == 1) {
        item.stickers.forEach(sticker => {
          const stickerExt = animationsCookie === 1 ? 'gif' : 'png';
          const stickerURL = `/imageProxy/sticker/${sticker.id}.${stickerExt}`;
          messagetext += `<br><img src="${stickerURL}" style="width: 100px; height: 100px;" alt="sticker">`;
        });
      } else {
        item.stickers.forEach(sticker => {
          messagetext += `<br>[Sticker: ${sticker.name || 'Unknown'}]`;
        });
      }
    }

    isMentioned = false;

    if (item?.embeds && item.embeds.length > 0) {
      const embedsToProcess = [];
      item.embeds.forEach(embed => {
        const isTenor = (embed.provider?.name === 'Tenor' || urlMatchesDomain(embed.url, 'tenor.com')) && embed.thumbnail?.url;
        const isGiphy = (embed.provider?.name === 'GIPHY' || urlMatchesDomain(embed.url, 'giphy.com')) && (embed.thumbnail?.url || embed.image?.url);
        const isYouTube = (embed.provider?.name === 'YouTube' || urlMatchesDomain(embed.url, 'youtube.com') || urlMatchesDomain(embed.url, 'youtu.be')) && embed.thumbnail?.url;

        if (isTenor && imagesCookie == 1) {
          const rawGifUrl = embed.thumbnail.url;
          if (!rawGifUrl) { embedsToProcess.push(embed); return; }
          const gifUrl = `/imageProxy/external/${Buffer.from(rawGifUrl).toString('base64')}`;
          const urlToFind = embed.url;
          let replaced = false;
          if (urlToFind) {
            const escapedUrl = urlToFind.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
            const anchorRegex = new RegExp(`<a href="${escapedUrl}">.*?</a>`, 'i');
            if (anchorRegex.test(messagetext)) {
              messagetext = messagetext.replace(anchorRegex, `<img src="${gifUrl}" style="max-width:256px;max-height:200px;" alt="Tenor GIF">`);
              replaced = true;
            }
          }
          if (!replaced) {
            messagetext += `<br><img src="${gifUrl}" style="max-width:256px;max-height:200px;" alt="Tenor GIF">`;
          }
        } else if (isGiphy && imagesCookie == 1) {
          const rawGifUrl = embed.image?.url || embed.thumbnail?.url;
          const gifUrl = rawGifUrl ? `/imageProxy/external/${Buffer.from(rawGifUrl).toString('base64')}` : null;
          const urlToFind = embed.url;
          let replaced = false;
          if (urlToFind && gifUrl) {
            const escapedUrl = urlToFind.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
            const anchorRegex = new RegExp(`<a href="${escapedUrl}">.*?</a>`, 'i');
            if (anchorRegex.test(messagetext)) {
              messagetext = messagetext.replace(anchorRegex, `<img src="${gifUrl}" style="max-width:256px;max-height:200px;" alt="GIPHY GIF">`);
              replaced = true;
            }
          }
          if (!replaced && gifUrl) {
            messagetext += `<br><img src="${gifUrl}" style="max-width:256px;max-height:200px;" alt="GIPHY GIF">`;
          }
        } else if (isYouTube && imagesCookie == 1) {
          const rawThumbnailUrl = embed.thumbnail.url;
          if (!rawThumbnailUrl) { embedsToProcess.push(embed); return; }
          const thumbnailUrl = `/imageProxy/external/${Buffer.from(rawThumbnailUrl).toString('base64')}`;
          const videoUrl = embed.url;
          if (rawThumbnailUrl) {
            messagetext += `<br><a href="${videoUrl}" target="_blank"><img src="${thumbnailUrl}" style="max-width:256px;max-height:200px;" alt="YouTube Video"></a>`;
          }
        } else if (embed.data?.type === 'image' || embed.data?.type === 'gifv') {
          if (imagesCookie == 1) {
            const rawImageUrl = embed.thumbnail?.url || embed.image?.url;
            if (!rawImageUrl) { return; }
            const imageUrl = `/imageProxy/external/${Buffer.from(rawImageUrl).toString('base64')}`;
            const urlToFind = embed.url;
            let replaced = false;
            if (urlToFind) {
              const escapedUrl = urlToFind.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
              const anchorRegex = new RegExp(`<a href="${escapedUrl}">.*?</a>`, 'i');
              if (anchorRegex.test(messagetext)) {
                messagetext = messagetext.replace(anchorRegex, `<img src="${imageUrl}" style="max-width:256px;max-height:200px;" alt="Image">`);
                replaced = true;
              }
            }
            if (!replaced) {
              messagetext += `<br><img src="${imageUrl}" style="max-width:256px;max-height:200px;" alt="Image">`;
            }
          }
        } else {
          embedsToProcess.push(embed);
        }
      });

      if (embedsToProcess.length > 0) {
        messagetext += processEmbeds(req, embedsToProcess, imagesCookie, animationsCookie, clientTimezone);
      }
    }

    if (item?.poll) {
      messagetext += processPoll(item.poll, imagesCookie);
    }

    if (item.mentions && item.mentions.members) {
      isMentioned = item.mentions.members.has(discordID);
    }

    if (!isMentioned && isReply && replyData.mentionsPing && replyData.authorId === discordID) {
      isMentioned = true;
    }

    if (!isMentioned && item.mentions && item.mentions.everyone) {
      isMentioned = true;
    }

    if (!isMentioned && item.mentions && item.mentions.roles) {
      item.mentions.roles.forEach(function (role) {
        if (member.roles.cache.has(role.id)) {
          isMentioned = true;
        }
      });
    }

    if (item.mentions && item.mentions.members) {
      item.mentions.members.forEach(function (user) {
        if (user) {
          messagetext = strReplace(messagetext, "&lt;@" + user.id.toString() + "&gt;", tmpl_mention.replace("{$USERNAME}", escape("@" + normalizeWeirdUnicode(user.displayName))));
          messagetext = strReplace(messagetext, "&lt;@!" + user.id.toString() + "&gt;", tmpl_mention.replace("{$USERNAME}", escape("@" + normalizeWeirdUnicode(user.displayName))));
        }
      });

      if (item.mentions.roles) {
        item.mentions.roles.forEach(function (role) {
          if (role) {
            messagetext = strReplace(messagetext, "&lt;@&amp;" + role.id.toString() + "&gt;", tmpl_mention.replace("{$USERNAME}", escape("@" + normalizeWeirdUnicode(role.name))));
          }
        });
      }
    }

    messagetext = messagetext.replace(/&lt;@!?(\d{17,19})&gt;/g, function(match, userId) {
      try {
        const cachedMember = chnl.guild.members.cache.get(userId);
        if (cachedMember) {
          return tmpl_mention.replace("{$USERNAME}", escape("@" + normalizeWeirdUnicode(cachedMember.displayName)));
        }
      } catch (err) {
        // Ignore errors
      }
      return tmpl_mention.replace("{$USERNAME}", "@unknown-user");
    });

    var regex = /&lt;#([0-9]{18})&gt;/g;
    var m;
    do {
      m = regex.exec(messagetext);
      if (m) {
        const channel = bot.client.channels.cache.get(m[1]);
        if (channel) {
          const channelLink = `/channels/${channel.id}`;
          messagetext = strReplace(messagetext, m[0], `<a href="${channelLink}" style="text-decoration:none;"><font style="background:rgba(88,101,242,0.15);color:#00b0f4;padding:0 2px;border-radius:3px;font-weight:500" face="rodin,sans-serif">#${escape(normalizeWeirdUnicode(channel.name))}</font></a>`);
        }
      }
    } while (m);

    if (item.mentions && item.mentions.everyone) {
      if (messagetext.includes("@everyone")) {
        messagetext = strReplace(messagetext, "@everyone", tmpl_mention.replace("{$USERNAME}", "@everyone"));
      }
      if (messagetext.includes("@here")) {
        messagetext = strReplace(messagetext, "@here", tmpl_mention.replace("{$USERNAME}", "@here"));
      }
    }

    if (item.mentions && item.mentions.roles) {
      item.mentions.roles.forEach(function (role) {
        if (role) {
          messagetext = strReplace(messagetext, "&lt;@&amp;" + role.id + "&gt;", tmpl_mention.replace("{$USERNAME}", escape("@" + normalizeWeirdUnicode(role.name))));
        }
      });
    }

    if (!lastauthor || !isSameUser(lastmember, lastauthor, currentMember, item.author) || item.createdAt - lastdate > 420000) {
      messagetext = tmpl_first_message_content.replace("{$MESSAGE_TEXT}", messagetext);
    } else {
      messagetext = tmpl_merged_message_content.replace("{$MESSAGE_TEXT}", messagetext);
    }

    const reactionsHtml = processReactions(item.reactions, imagesCookie, tmpl_reactions, tmpl_reaction, animationsCookie);
    messagetext = strReplace(messagetext, "{$MESSAGE_REACTIONS}", reactionsHtml);

    const isSystemMessage = item.type !== 0 && item.type !== 19;
    const tempDiv = messagetext.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

    if (!isSystemMessage && tempDiv.length === 0 && (!item.attachments || item.attachments.size === 0) && (!item.embeds || item.embeds.length === 0) && (!item.stickers || item.stickers.size === 0)) {
      return;
    }

    if (isSystemMessage && tempDiv.length === 0) {
      const systemMessages = {
        1: 'added a new member',
        2: 'left',
        3: 'boosted the server',
        7: 'welcomed a new member',
        8: 'boosted the server to level 1',
        9: 'boosted the server to level 2',
        10: 'boosted the server to level 3',
        11: 'followed this channel',
        12: 'went live'
      };

      const systemText = systemMessages[item.type] || 'performed an action';
      messagetext = `<font style="font-size:14px;color:`+authorText+`;font-style:italic;" face="rodin,sans-serif">${systemText}</font>`;
    }

    lastauthor = item.author;
    lastmember = currentMember;
    lastdate = item.createdAt;
    currentmessage += messagetext;
    messageid = item.id;

    lastMentioned = isMentioned;
    lastReply = isReply;
    lastReplyData = replyData;
  };

  for (const item of messages) {
    await handlemessage(item);
  }

  islastmessage = true;
  await handlemessage();

  response = removeExistingEndAnchors(response);
  response += '<a id="end" name="end"></a>';
  return response;
};

exports.processChannel = async function processChannel(bot, req, res, args, discordID) {
  const whiteThemeCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('whiteThemeCookie='))?.split('=')[1];
  const urlSessionID = url.parse(req.url, true).query.sessionID || '';
  const sessionParam = urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '';

  let boxColor;
  let authorText;
  let replyText;
  let template;
  
  boxColor = "#ffffff";
  authorText = "#72767d";
  replyText = "#b5bac1";
    
  // Apply theme class based on cookie value: 0=dark (default), 1=light, 2=amoled
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
    boxColor = "#40444b";
    authorText = "#72767d";
    replyText = "#b5bac1";
    template = strReplace(channel_template, "{$WHITE_THEME_ENABLED}", "");
  }

  const clientIsReady = bot && bot.client && (typeof bot.client.isReady === 'function' ? bot.client.isReady() : !!bot.client.uptime);
  
  if (!clientIsReady) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.write("The bot isn't connected, try again in a moment");
    res.end();
    return;
  }
  
  const imagesCookieValue = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('images='))?.split('=')[1];
  const imagesCookie = imagesCookieValue !== undefined ? parseInt(imagesCookieValue) : 1;  // Default to 1 (on)
  
  const animationsCookieValue = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('animations='))?.split('=')[1];
  const animationsCookie = animationsCookieValue !== undefined ? parseInt(animationsCookieValue) : 1;  // Default to 1 (on)
    
  // Get client's timezone from IP
  const clientIP = getClientIP(req);
  const clientTimezone = getTimezoneFromIP(clientIP);
    
  try {
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
      
      const user = member.user;
      let username = user.tag;
      if (member.displayName != user.username) {
        username = member.displayName + " (@" + user.tag + ")";
      }

      if (!member.permissionsIn(chnl).has(PermissionFlagsBits.ViewChannel, true) || !botMember.permissionsIn(chnl).has(PermissionFlagsBits.ViewChannel, true)) {
        res.write("You (or the bot) don't have permission to do that!");
        res.end();
        return;
      }

      if (!member.permissionsIn(chnl).has(PermissionFlagsBits.ReadMessageHistory, true)) {
        template = strReplace(template, "{$SERVER_ID}", chnl.guild.id)
        template = strReplace(template, "{$CHANNEL_ID}", chnl.id)

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

        final = strReplace(final, "{$MESSAGES}", no_message_history_template);
        final = strReplace(final, "{$SESSION_ID}", urlSessionID);
        final = strReplace(final, "{$SESSION_PARAM}", sessionParam);

        res.write(final); //write a response to the client
        res.end(); //end the response
        return;
      }

      console.log("Processed valid channel request");
      const response = await exports.buildMessagesHtml({
        bot, chnl, member, discordID, req,
        imagesCookie, animationsCookie,
        authorText, replyText, clientTimezone,
        channelId: args[2],
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

      template = strReplace(template, "{$SERVER_ID}", chnl.guild.id)
      template = strReplace(template, "{$CHANNEL_ID}", chnl.id)
      template = strReplace(template, "{$REFRESH_URL}", chnl.id + "?random=" + Math.random() + (urlSessionID ? '&sessionID=' + encodeURIComponent(urlSessionID) : ''))

      let final;
      if (!botMember.permissionsIn(chnl).has(PermissionFlagsBits.ManageWebhooks, true)) {
        const input_template1 = strReplace(input_disabled_template, "{$COLOR}", boxColor);
        final = strReplace(template, "{$INPUT}", input_template1);
        final = strReplace(final, "You don't have permission to send messages in this channel.", "Discross bot doesn't have the Manage Webhooks permission");
      } else if (member.permissionsIn(chnl).has(PermissionFlagsBits.SendMessages, true)) {
        const input_template1 = strReplace(input_template, "{$COLOR}", boxColor);
        final = strReplace(template, "{$INPUT}", input_template1);
      } else {
        const input_template1 = strReplace(input_disabled_template, "{$COLOR}", boxColor);
        final = strReplace(template, "{$INPUT}", input_template1);
      }

      const randomEmoji = ["1f62d", "1f480", "2764-fe0f", "1f44d", "1f64f", "1f389", "1f642"][Math.floor(Math.random() * 7)];
      final = strReplace(final, "{$RANDOM_EMOJI}", randomEmoji);
      final = strReplace(final, "{$CHANNEL_NAME}", normalizeWeirdUnicode(chnl.name));
      final = strReplace(final, "{$MESSAGES}", response);
      final = strReplace(final, "{$SESSION_ID}", urlSessionID);
      final = strReplace(final, "{$SESSION_PARAM}", sessionParam);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.write(final); //write a response to the client
      res.end(); //end the response
    } else {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.write("Invalid channel!"); //write a response to the client
      res.end(); //end the response
    }
  } catch (error) {
    console.log(error)
    // res.writeHead(302, { "Location": "/server/" });
    res.writeHead(500, { "Content-Type": "text/html" });
    res.write("An error occurred! Please try again later.<br>"); //write a response to the client
    // res.write(error.toString());
    res.end();
  }
}