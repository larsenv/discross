'use strict';

const fs = require('fs');
const escape = require('escape-html');
const he = require('he');
const { PermissionFlagsBits, MessageReferenceType } = require('discord.js');
const { renderDiscordMarkdown } = require('./discordMarkdown');
const { getDisplayName, getMemberColor, ensureMemberData } = require('./memberUtils');
const {
  getClientIP, getTimezoneFromIP,
  formatDateWithTimezone, formatDateSeparator,
  areDifferentDays, formatForwardedTimestamp,
} = require('../timezoneUtils');
const { processEmbeds } = require('./embedUtils');
const { processReactions } = require('./reactionUtils');
const { processPoll } = require('./pollUtils');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const { unicodeToTwemojiCode, cacheCustomEmoji } = require('./emojiUtils');
const emojiRegex = require('./twemojiRegex').regex;
const notFound = require('./notFound.js');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FORWARDED_CONTENT_MAX_LENGTH = 100;
const REPLY_CONTENT_MAX_LENGTH = 50;
const MESSAGE_GROUP_TIMEOUT_MS = 420_000; // 7 minutes

const SYSTEM_MESSAGE_TEXT = {
  1: 'added a new member',
  2: 'left',
  3: 'boosted the server',
  4: 'changed the channel name',
  5: 'changed the channel icon',
  6: 'pinned a message to this channel',
  7: 'welcomed a new member',
  8: 'boosted the server to level 1',
  9: 'boosted the server to level 2',
  10: 'boosted the server to level 3',
  11: 'followed this channel',
  12: 'went live',
  14: 'is no longer eligible for Server Discovery',
  15: 'is eligible for Server Discovery again',
  17: 'started a thread',
  23: 'flagged a message with AutoMod',
  24: 'purchased a role subscription',
  26: 'started a stage',
  27: 'ended the stage',
  30: 'changed the stage topic',
  36: 'enabled raid alert mode',
  37: 'disabled raid alert mode',
  38: 'reported a raid',
  39: 'reported a false alarm',
  46: 'Poll ended',
};

const THEME_CONFIG = {
  0: { boxColor: '#222327', authorText: '#72767d', replyText: '#b5bac1', themeClass: '' },
  1: { boxColor: '#ffffff', authorText: '#000000', replyText: '#000000', themeClass: 'class="light-theme"' },
  2: { boxColor: '#141416', authorText: '#72767d', replyText: '#b5bac1', themeClass: 'class="amoled-theme"' },
};

const RANDOM_EMOJIS = ['1f62d', '1f480', '2764-fe0f', '1f44d', '1f64f', '1f389', '1f642'];

// ---------------------------------------------------------------------------
// Template loading
// ---------------------------------------------------------------------------

function readTemplate(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  return content.replace(/#end(?=["'])/g, '');
}

const TEMPLATES = {
  message:                   readTemplate('pages/templates/message/message.html'),
  messageForwarded:          readTemplate('pages/templates/message/forwarded_message.html'),
  messageMentioned:          readTemplate('pages/templates/message/message_mentioned.html'),
  messageForwardedMentioned: readTemplate('pages/templates/message/forwarded_message_mentioned.html'),
  channel: fs.readFileSync('pages/templates/channel.html', 'utf-8')
              .split('{$COMMON_HEAD}')
              .join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8')),
  firstMessageContent:  fs.readFileSync('pages/templates/message/first_message_content.html', 'utf-8'),
  mergedMessageContent: fs.readFileSync('pages/templates/message/merged_message_content.html', 'utf-8'),
  mention:              fs.readFileSync('pages/templates/message/mention.html', 'utf-8'),
  input:                fs.readFileSync('pages/templates/channel/input.html', 'utf-8'),
  inputDisabled:        fs.readFileSync('pages/templates/channel/input_disabled.html', 'utf-8'),
  noMessageHistory:     fs.readFileSync('pages/templates/channel/no_message_history.html', 'utf-8'),
  fileDownload:         fs.readFileSync('pages/templates/channel/file_download.html', 'utf-8'),
  reactions:            fs.readFileSync('pages/templates/message/reactions.html', 'utf-8'),
  reaction:             fs.readFileSync('pages/templates/message/reaction.html', 'utf-8'),
  dateSeparator:        fs.readFileSync('pages/templates/message/date_separator.html', 'utf-8'),
  messageContinuation:  fs.readFileSync('pages/templates/message/message_continuation.html', 'utf-8'),
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement ?? '');
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0.00 Bytes';
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

function removeExistingEndAnchors(html) {
  return html.replace(/<a[^>]*(?:id=['"]end['"]|name=['"]end['"])[^>]*>[\s\S]*?<\/a>/gi, '');
}

function urlMatchesDomain(url, domain) {
  try {
    const { hostname } = new URL(url);
    return hostname === domain || hostname.endsWith('.' + domain);
  } catch {
    return false;
  }
}

function truncateFileName(name) {
  if (name.length <= 30) return name;
  const ext = name.replace(/(.*\.)(.*)$/, '$2');
  const base = name.replace(/(.*\.)(.*)$/, '$1').slice(0, 25);
  return `${base}...${ext}`;
}

function truncateText(text, maxLength) {
  return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
}

function isSameAuthor(member1, author1, member2, author2) {
  if (member1 && member2) return member1.user.id === member2.user.id;
  return author1.id === author2.id && author1.username === author2.username;
}

function isNormalMessage(type) {
  return type === 0 || type === 19;
}

// ---------------------------------------------------------------------------
// Emoji rendering
// ---------------------------------------------------------------------------

function renderEmojis(messagetext, item, imagesCookie, animationsCookie) {
  if (imagesCookie !== 1) return messagetext;

  // Jumbo detection
  const customEmojiRegex = /<a?:.+?:\d{17,19}>/g;
  const customMatches = item.content.match(customEmojiRegex) ?? [];
  const unicodeMatches = item.content.match(emojiRegex) ?? [];
  const totalEmojis = customMatches.length + unicodeMatches.length;
  const stripped = item.content.replace(customEmojiRegex, '').replace(emojiRegex, '').trim();
  const isJumbo = stripped.length === 0 && totalEmojis > 0 && totalEmojis <= 29;

  const size = isJumbo ? '2.75em' : '1.375em';
  const px = isJumbo ? 44 : 22;
  const imgStyle = `width: ${size}; height: ${size}; vertical-align: -0.2em;`;

  // Unicode emoji — single-pass replacement (avoids O(n×m) per-emoji string scans)
  messagetext = messagetext.replace(emojiRegex, match => {
    const code = unicodeToTwemojiCode(match);
    return `<img src="/resources/twemoji/${code}.gif" width="${px}" height="${px}" style="${imgStyle}" alt="emoji" onerror="this.style.display='none'">`;
  });

  // Custom emoji
  [...messagetext.matchAll(/&lt;(:)?(?:(a):)?(\w{2,32}):(\d{17,19})?(?:(?!\1).)*&gt;/g)].forEach(match => {
    const animated = !!match[2];
    const ext = animated && animationsCookie === 1 ? 'gif' : 'png';
    cacheCustomEmoji(match[4], match[3], animated);
    messagetext = messagetext.replace(
      match[0],
      `<img src="/imageProxy/emoji/${match[4]}.${ext}" width="${px}" height="${px}" style="${imgStyle}" alt="emoji" onerror="this.style.display='none'">`,
    );
  });

  return messagetext;
}

// ---------------------------------------------------------------------------
// Attachment rendering
// ---------------------------------------------------------------------------

function renderAttachments(messagetext, item, imagesCookie, tmpl_file_download) {
  if (!item?.attachments?.size) return messagetext;

  const IMAGE_EXT = /\.(jpg|gif|png|jpeg|avif|svg|webp|tif|tiff)$/i;
  const VIDEO_EXT = /\.(mp4|webm|mov|avi|mkv)$/i;
  const imageUrls = [];

  item.attachments.forEach(attachment => {
    const isImage = IMAGE_EXT.test(attachment.name);
    const isVideo = VIDEO_EXT.test(attachment.name);
    const proxyBase = isImage && imagesCookie === 1 ? '/imageProxy/' : '/fileProxy/';
    const url = proxyBase + attachment.url.replace(/^(.*?)(\d+)/, '$2');

    if (isImage && imagesCookie === 1) {
      imageUrls.push(url);
    } else {
      // File download card
      let card = tmpl_file_download;
      card = card.replace('{$FILE_NAME}', truncateFileName(attachment.name));
      card = card.replace('{$FILE_SIZE}', formatFileSize(attachment.size));
      messagetext += card;
      if (!isVideo || imagesCookie !== 1) {
        messagetext = strReplace(messagetext, '{$FILE_LINK}', url);
      }
    }
  });

  imageUrls.forEach(url => {
    messagetext += `<br><a href="${url}" target="_blank"><img src="${url}" style="max-width:256px;max-height:200px;height:auto;" alt="image"></a>`;
  });

  return messagetext;
}

// ---------------------------------------------------------------------------
// Sticker rendering
// ---------------------------------------------------------------------------

function renderStickers(messagetext, item, imagesCookie, animationsCookie) {
  if (!item.stickers?.size) return messagetext;

  item.stickers.forEach(sticker => {
    if (imagesCookie === 1) {
      const ext = animationsCookie === 1 ? 'gif' : 'png';
      messagetext += `<br><img src="/imageProxy/sticker/${sticker.id}.${ext}" style="width:100px;height:100px;" alt="sticker">`;
    } else {
      messagetext += `<br>[Sticker: ${sticker.name ?? 'Unknown'}]`;
    }
  });

  return messagetext;
}

// ---------------------------------------------------------------------------
// Embed rendering (inline media types handled here; rich embeds delegated)
// ---------------------------------------------------------------------------

function buildProxiedImageTag(rawUrl, alt, style = 'max-width:256px;max-height:200px;height:auto;') {
  const proxied = `/imageProxy/external/${Buffer.from(rawUrl).toString('base64')}`;
  return { proxied, tag: `<img src="${proxied}" style="${style}" alt="${alt}">` };
}

function replaceOrAppendMedia(messagetext, embedUrl, imgHtml) {
  if (embedUrl) {
    const escaped = embedUrl.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const re = new RegExp(`<a href="${escaped}">.*?</a>`, 'i');
    if (re.test(messagetext)) return messagetext.replace(re, imgHtml);
  }
  return messagetext + '<br>' + imgHtml;
}

function renderEmbeds(messagetext, item, req, imagesCookie, animationsCookie, clientTimezone) {
  if (!item?.embeds?.length) return messagetext;

  const richEmbeds = [];

  item.embeds.forEach(embed => {
    const isTenor = (embed.provider?.name === 'Tenor' || urlMatchesDomain(embed.url, 'tenor.com')) && embed.thumbnail?.url;
    const isGiphy = (embed.provider?.name === 'GIPHY' || urlMatchesDomain(embed.url, 'giphy.com')) && (embed.thumbnail?.url || embed.image?.url);
    const isYouTube = (embed.provider?.name === 'YouTube' || urlMatchesDomain(embed.url, 'youtube.com') || urlMatchesDomain(embed.url, 'youtu.be')) && embed.thumbnail?.url;

    if (imagesCookie !== 1) {
      if (!isTenor && !isGiphy) richEmbeds.push(embed);
      return;
    }

    if (isTenor) {
      const { tag } = buildProxiedImageTag(embed.thumbnail.url, 'Tenor GIF');
      messagetext = replaceOrAppendMedia(messagetext, embed.url, tag);
    } else if (isGiphy) {
      const rawUrl = embed.image?.url ?? embed.thumbnail?.url;
      if (rawUrl) {
        const { tag } = buildProxiedImageTag(rawUrl, 'GIPHY GIF');
        messagetext = replaceOrAppendMedia(messagetext, embed.url, tag);
      }
    } else if (isYouTube) {
      // Render as a Discord-style rich embed with the thumbnail as the main image
      richEmbeds.push({
        color: embed.color,
        author: embed.author,
        title: embed.title,
        url: embed.url,
        description: embed.description,
        fields: embed.fields,
        image: embed.image ?? embed.thumbnail,
        thumbnail: null,
        footer: embed.footer,
        timestamp: embed.timestamp,
        data: embed.data,
      });
    } else if (embed.data?.type === 'poll_result') {
      messagetext += renderPollResultEmbed(embed);
    } else if (embed.data?.type === 'image' || embed.data?.type === 'gifv') {
      const rawUrl = embed.thumbnail?.url ?? embed.image?.url;
      if (rawUrl) {
        const { tag } = buildProxiedImageTag(rawUrl, 'Image');
        messagetext = replaceOrAppendMedia(messagetext, embed.url, tag);
      }
    } else {
      richEmbeds.push(embed);
    }
  });

  if (richEmbeds.length > 0) {
    messagetext += processEmbeds(req, richEmbeds, imagesCookie, animationsCookie, clientTimezone);
  }

  return messagetext;
}

function renderPollResultEmbed(embed) {
  const fieldMap = {};
  (embed.fields ?? []).forEach(f => { fieldMap[f.name] = f.value; });

  const question    = fieldMap['poll_question_text']    ?? '';
  const winnerText  = fieldMap['victor_answer_text']    ?? '';
  const winnerEmoji = fieldMap['victor_answer_emoji_name'] ?? '';
  const winnerVotes = fieldMap['victor_answer_votes']   ?? '0';
  const totalVotes  = fieldMap['total_votes']            ?? '0';
  const emojiPart   = winnerEmoji ? escape(winnerEmoji) + ' ' : '';

  return `<div style="font-size:14px;color:#b9bbbe;margin-top:4px;">` +
    `Poll ended: <b>${escape(question)}</b><br>` +
    `Winner: ${emojiPart}<b>${escape(winnerText)}</b> (${escape(winnerVotes)}/${escape(totalVotes)} votes)` +
    `</div>`;
}

// ---------------------------------------------------------------------------
// Mention resolution
// ---------------------------------------------------------------------------

function roleMentionPill(role, tmpl_mention) {
  const name = escape('@' + normalizeWeirdUnicode(role.name));
  if (role.color !== 0) {
    const hex = role.hexColor;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `<span class="mention" style="color:${hex};background:rgba(${r},${g},${b},0.15);">${name}</span>`;
  }
  return `<span class="mention">${name}</span>`;
}

function renderKnownMentions(messagetext, item, tmpl_mention) {
  if (!item.mentions?.members) return messagetext;

  item.mentions.members.forEach(user => {
    if (!user) return;
    const pill = tmpl_mention.replace('{$USERNAME}', escape('@' + normalizeWeirdUnicode(user.displayName)));
    messagetext = strReplace(messagetext, `&lt;@${user.id}&gt;`, pill);
    messagetext = strReplace(messagetext, `&lt;@!${user.id}&gt;`, pill);
  });

  item.mentions.roles?.forEach(role => {
    if (!role) return;
    messagetext = strReplace(messagetext, `&lt;@&amp;${role.id}&gt;`, roleMentionPill(role, tmpl_mention));
  });

  return messagetext;
}

async function resolveRemainingMentions(messagetext, chnl, memberCache, tmpl_mention) {
  // Fetch any member IDs not yet in cache
  const unresolvedIds = [...messagetext.matchAll(/&lt;@!?(\d{17,19})&gt;/g)]
    .map(m => m[1])
    .filter(id => !memberCache.has(id));

  await Promise.allSettled(unresolvedIds.map(async id => {
    try {
      memberCache.set(id, await chnl.guild.members.fetch(id));
    } catch {
      memberCache.set(id, null);
    }
  }));

  return messagetext.replace(/&lt;@!?(\d{17,19})&gt;/g, (match, userId) => {
    const resolved = memberCache.get(userId) ?? chnl.guild.members.cache.get(userId);
    if (resolved) {
      return tmpl_mention.replace('{$USERNAME}', escape('@' + normalizeWeirdUnicode(getDisplayName(resolved, resolved.user))));
    }
    return tmpl_mention.replace('{$USERNAME}', '@unknown-user');
  });
}

async function resolveChannelMentions(messagetext, bot, chnl) {
  const unresolvedIds = [...messagetext.matchAll(/&lt;#(\d{17,19})&gt;/g)]
    .map(m => m[1])
    .filter(id => !bot.client.channels.cache.has(id));

  await Promise.allSettled(unresolvedIds.map(async id => {
    try { await bot.client.channels.fetch(id); } catch { /* not accessible */ }
  }));

  return messagetext.replace(/&lt;#(\d{17,19})&gt;/g, (match, id) => {
    const ch = bot.client.channels.cache.get(id);
    if (!ch) return match;
    return `<a href="/channels/${ch.id}" style="text-decoration:none;"><span class="mention">#${escape(normalizeWeirdUnicode(ch.name))}</span></a>`;
  });
}

function renderEveryoneMentions(messagetext, item, tmpl_mention) {
  if (!item.mentions?.everyone) return messagetext;
  if (messagetext.includes('@everyone')) {
    messagetext = strReplace(messagetext, '@everyone', tmpl_mention.replace('{$USERNAME}', '@everyone'));
  }
  if (messagetext.includes('@here')) {
    messagetext = strReplace(messagetext, '@here', tmpl_mention.replace('{$USERNAME}', '@here'));
  }
  return messagetext;
}

// ---------------------------------------------------------------------------
// isMentioned detection
// ---------------------------------------------------------------------------

function detectMention(item, member, discordID, isReply, replyData) {
  if (item.mentions?.members?.has(discordID)) return true;
  if (isReply && replyData.mentionsPing && replyData.authorId === discordID) return true;
  if (item.mentions?.everyone) return true;
  if (item.mentions?.roles) {
    for (const role of item.mentions.roles.values()) {
      if (member.roles.cache.has(role.id)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Forward data resolution
// ---------------------------------------------------------------------------

async function resolveForwardData(item, chnl, bot, discordID, memberCache, clientTimezone, req, imagesCookie, animationsCookie) {
  try {
    const fwdMsg = await item.fetchReference();
    let fwdMember = null;
    if (!fwdMsg.author?.bot) {
      fwdMember = await ensureMemberData(fwdMsg, chnl.guild, memberCache);
    }

    const content = truncateText(fwdMsg.content, FORWARDED_CONTENT_MAX_LENGTH);
    let originHtml = '';

    try {
      const snowflakeRe = /^\d{17,19}$/;
      if (fwdMsg.guildId && snowflakeRe.test(fwdMsg.channelId) && snowflakeRe.test(fwdMsg.id)) {
        const fwdChannel = fwdMsg.channel ?? bot.client.channels.cache.get(fwdMsg.channelId);
        if (fwdChannel) {
          const timeDisplay = formatForwardedTimestamp(fwdMsg.createdAt, clientTimezone);
          const jumpLink = `/channels/${fwdMsg.channelId}/${fwdMsg.id}`;
          const chanLink = `<a href="${jumpLink}" class="forwarded-label" style="text-decoration:none">#${escape(normalizeWeirdUnicode(fwdChannel.name))} &bull; ${timeDisplay}</a>`;

          if (fwdMsg.guildId === chnl.guild.id) {
            originHtml = `<font class="forwarded-label" style="font-size:12px" face="rodin,sans-serif">${chanLink}</font>`;
          } else {
            const otherGuild = bot.client.guilds.cache.get(fwdMsg.guildId);
            if (otherGuild) {
              try {
                await otherGuild.members.fetch(discordID);
                originHtml = `<font class="forwarded-label" style="font-size:12px" face="rodin,sans-serif">${escape(normalizeWeirdUnicode(otherGuild.name))} &gt; ${chanLink}</font>`;
              } catch { /* user not in that guild */ }
            }
          }
        }
      }
    } catch { originHtml = ''; }

    const embedsHtml = renderEmbeds('', fwdMsg, req, imagesCookie, animationsCookie, clientTimezone);

    return {
      author: getDisplayName(fwdMember, fwdMsg.author),
      content: renderDiscordMarkdown(content),
      date: formatDateWithTimezone(fwdMsg.createdAt, clientTimezone),
      origin: originHtml,
      embeds: embedsHtml,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reply data resolution
// ---------------------------------------------------------------------------

// Replaces <@userId>, <@!userId>, <@&roleId>, and <#channelId> in raw Discord text
// with plain @Name / #channel-name strings, using the known mentions on the message
// plus memberCache. Unresolved member/channel IDs are fetched from the API.
// This is run before truncation so mention tokens are never split mid-string.
async function resolveRawMentionsForPreview(text, msg, memberCache, chnl, bot) {
  msg.mentions?.members?.forEach(member => {
    if (!member) return;
    const name = '@' + normalizeWeirdUnicode(getDisplayName(member, member.user));
    text = text.split(`<@${member.id}>`).join(name);
    text = text.split(`<@!${member.id}>`).join(name);
  });
  msg.mentions?.roles?.forEach(role => {
    if (!role) return;
    text = text.split(`<@&${role.id}>`).join('@' + normalizeWeirdUnicode(role.name));
  });
  // Fetch any remaining unrecognized user IDs from the API
  const unresolvedUserIds = [...text.matchAll(/<@!?(\d{17,19})>/g)]
    .map(m => m[1])
    .filter(id => !memberCache.has(id));
  await Promise.allSettled(unresolvedUserIds.map(async id => {
    try { memberCache.set(id, await chnl.guild.members.fetch(id)); }
    catch { memberCache.set(id, null); }
  }));
  text = text.replace(/<@!?(\d{17,19})>/g, (match, id) => {
    const cached = memberCache.get(id) ?? chnl.guild.members.cache.get(id);
    if (cached) return '@' + normalizeWeirdUnicode(getDisplayName(cached, cached.user));
    return match;
  });
  // Fetch any unresolved channel IDs from the API
  const unresolvedChannelIds = [...text.matchAll(/<#(\d{17,19})>/g)]
    .map(m => m[1])
    .filter(id => !bot.client.channels.cache.has(id));
  await Promise.allSettled(unresolvedChannelIds.map(async id => {
    try { await bot.client.channels.fetch(id); } catch { /* not accessible */ }
  }));
  text = text.replace(/<#(\d{17,19})>/g, (match, id) => {
    const ch = bot.client.channels.cache.get(id);
    if (ch) return '#' + normalizeWeirdUnicode(ch.name);
    return match;
  });
  return text;
}

async function resolveReplyData(item, chnl, memberCache, bot, imagesCookie, animationsCookie) {
  try {
    let replyUser = item.mentions?.repliedUser;
    let replyMember;
    let replyMessage;

    try {
      replyMessage = await item.fetchReference();
      replyUser = replyMessage.author;
    } catch { /* deleted or inaccessible */ }

    if (replyMessage) {
      if (!replyMessage.author?.bot) {
        replyMember = await ensureMemberData(replyMessage, chnl.guild, memberCache);
      }
    } else if (replyUser?.id) {
      const cached = memberCache.get(replyUser.id);
      if (cached !== undefined) {
        replyMember = cached;
      } else {
        try {
          replyMember = await chnl.guild.members.fetch(replyUser.id);
          memberCache.set(replyUser.id, replyMember);
        } catch { /* left the server */ }
      }
    }

    let replyContent = '';
    if (replyMessage?.content) {
      let flat = replyMessage.content.replace(/\r?\n/g, ' ').replace(/  +/g, ' ').trim();
      // Resolve mentions/channels in raw text before truncation so they are never cut in half
      flat = await resolveRawMentionsForPreview(flat, replyMessage, memberCache, chnl, bot);
      // Strip block-level quote markers (>>> and >) so they don't render as
      // full blockquote embeds inside the reply preview — show them as plain > text
      flat = flat.replace(/^(>>?>?\s*)+/, '');
      replyContent = renderDiscordMarkdown(truncateText(flat, REPLY_CONTENT_MAX_LENGTH));
      replyContent = renderEmojis(replyContent, replyMessage, imagesCookie, animationsCookie);
    }

    return {
      author: getDisplayName(replyMember, replyUser),
      authorId: replyUser?.id,
      authorColor: getMemberColor(replyMember),
      mentionsPing: item.mentions?.repliedUser != null,
      content: replyContent,
    };
  } catch (err) {
    console.error('Could not process reply data:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reply indicator HTML
// ---------------------------------------------------------------------------

function buildReplyIndicator(replyData, replyText) {
  const atSign = replyData.mentionsPing ? '@' : '';
  // Two-row layout: row 1 is an empty connector spacer; row 2 draws the ┌ corner
  // (border-top + border-left + border-top-left-radius) inline so no CSS class is needed.
  // The author and content cells each span both rows (rowspan="2") so the row boundary is exactly
  // at 50% of the content height, placing the ┌ corner at the vertical center of the quoted text.
  // Content is in its own cell so its white-space:nowrap doesn't interact with the author width.
  // JS truncateText already limits the raw text to REPLY_CONTENT_MAX_LENGTH chars + "...",
  // so no CSS overflow clipping is needed on the content cell.
  const contentTd = replyData.content
    ? `<td rowspan="2" style="padding-left:4px;vertical-align:middle;white-space:nowrap">` +
      `<font style="font-size:11px;color:${replyText}" face="rodin,sans-serif">${replyData.content}</font></td>`
    : '';
  return '<table cellpadding="0" cellspacing="0" style="margin-bottom:4px"><tr>' +
    '<td style="width:12px;height:8px"></td>' +
    `<td rowspan="2" style="padding-left:8px;vertical-align:middle;white-space:nowrap">` +
    `<font style="font-size:11px;font-weight:600;color:${replyData.authorColor}" face="rodin,sans-serif">${atSign}${escape(replyData.author)}</font>` +
    `</td>${contentTd}` +
    '</tr><tr>' +
    '<td style="width:12px;height:8px;border-left:2px solid #4e5058;border-top:2px solid #4e5058;border-top-left-radius:4px"></td>' +
    '</tr></table>';
}

// ---------------------------------------------------------------------------
// Interaction (slash command) data resolution
// ---------------------------------------------------------------------------

async function resolveInteractionData(item, chnl, memberCache) {
  try {
    const interactionUser = item.interaction?.user;
    if (!interactionUser) return null;

    let interactionMember;
    const cached = memberCache.get(interactionUser.id);
    if (cached !== undefined) {
      interactionMember = cached;
    } else {
      try {
        interactionMember = await chnl.guild.members.fetch(interactionUser.id);
        memberCache.set(interactionUser.id, interactionMember);
      } catch { /* user left or not in guild */ }
    }

    return {
      author: getDisplayName(interactionMember, interactionUser),
      authorColor: getMemberColor(interactionMember),
      commandName: item.interaction.commandName,
    };
  } catch (err) {
    console.error('Could not process interaction data:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Interaction indicator HTML
// ---------------------------------------------------------------------------

function buildInteractionIndicator(interactionData, textColor) {
  return '<table cellpadding="0" cellspacing="0" style="margin-bottom:4px"><tr>' +
    '<td style="width:12px;height:10px;border-left:2px solid #4e5058;border-top:2px solid #4e5058;border-top-left-radius:4px;vertical-align:middle"></td>' +
    `<td style="padding-left:4px;vertical-align:middle;overflow:hidden;max-width:400px;white-space:nowrap">` +
    `<font style="font-size:12px;font-weight:600;color:${interactionData.authorColor}" face="rodin,sans-serif">${escape(interactionData.author)}</font>` +
    `<font style="font-size:12px;color:${textColor}" face="rodin,sans-serif"> used /${escape(interactionData.commandName)}</font>` +
    `</td>` +
    '</tr></table>';
}

// ---------------------------------------------------------------------------
// Message group flushing
// ---------------------------------------------------------------------------

function flushMessageGroup(state, templates, authorText, replyText, channelId) {
  const {
    currentmessage, isForwarded, forwardData,
    lastMentioned, lastReply, lastReplyData,
    lastInteraction, lastInteractionData,
    lastauthor, lastmember, lastdate, messageid,
    isContinuationBlock,
  } = state;

  let html = currentmessage;

  // Wrap in appropriate outer template
  if (isContinuationBlock && !isForwarded && !lastMentioned) {
    html = templates.messageContinuation.replace('{$MESSAGE_CONTENT}', html);
  } else if (isForwarded && lastMentioned) {
    html = templates.messageForwardedMentioned.replace('{$MESSAGE_CONTENT}', html);
  } else if (isForwarded) {
    html = templates.messageForwarded.replace('{$MESSAGE_CONTENT}', html);
  } else if (lastMentioned) {
    html = templates.messageMentioned.replace('{$MESSAGE_CONTENT}', html);
    html = html.replace('{$MESSAGE_REPLY_LINK}', channelId ? `/channels/${channelId}/${messageid}` : 'javascript:void(0)');
  } else {
    html = templates.message.replace('{$MESSAGE_CONTENT}', html);
    html = html.replace('{$MESSAGE_REPLY_LINK}', channelId ? `/channels/${channelId}/${messageid}` : 'javascript:void(0)');
  }

  // Forwarded metadata
  if (isForwarded) {
    html = html.replace('{$FORWARDED_AUTHOR}',  escape(forwardData.author));
    html = html.replace('{$FORWARDED_CONTENT}', forwardData.content);
    html = html.replace('{$FORWARDED_DATE}',    forwardData.date);
    html = html.replace('{$FORWARDED_EMBEDS}',  forwardData.embeds ?? '');
    html = html.replace('{$FORWARDED_ORIGIN}',  forwardData.origin ?? '');
  }

  const displayName  = getDisplayName(lastmember, lastauthor);
  const authorColor  = getMemberColor(lastmember, authorText);
  const replyIndicator = lastReply
    ? buildReplyIndicator(lastReplyData, replyText)
    : (lastInteraction ? buildInteractionIndicator(lastInteractionData, replyText) : '');

  html = html.replace('{$MESSAGE_AUTHOR}', escape(displayName));
  html = strReplace(html, '{$AUTHOR_COLOR}',    authorColor);
  html = strReplace(html, '{$REPLY_INDICATOR}', replyIndicator);
  html = strReplace(html, '{$PING_INDICATOR}',  '');
  html = strReplace(html, '{$MESSAGE_DATE}',    formatDateWithTimezone(lastdate, state.clientTimezone));
  html = strReplace(html, '{$TAG}',             he.encode(JSON.stringify(`<@${lastauthor.id}>`)));

  return html;
}

// ---------------------------------------------------------------------------
// Core message rendering
// ---------------------------------------------------------------------------

async function renderMessageContent(item, context) {
  const {
    bot, chnl, member, discordID, req,
    imagesCookie, animationsCookie, clientTimezone,
    memberCache, templates,
  } = context;

  let messagetext = renderDiscordMarkdown(item.content);

  messagetext = renderEmojis(messagetext, item, imagesCookie, animationsCookie);
  messagetext = renderAttachments(messagetext, item, imagesCookie, templates.fileDownload);
  messagetext = renderStickers(messagetext, item, imagesCookie, animationsCookie);
  messagetext = renderEmbeds(messagetext, item, req, imagesCookie, animationsCookie, clientTimezone);

  if (item?.poll) {
    messagetext += processPoll(item.poll, imagesCookie);
  }

  messagetext = renderKnownMentions(messagetext, item, templates.mention);
  messagetext = await resolveRemainingMentions(messagetext, chnl, memberCache, templates.mention);
  messagetext = await resolveChannelMentions(messagetext, bot, chnl);
  messagetext = renderEveryoneMentions(messagetext, item, templates.mention);

  // Role mentions (second pass — catches any remaining after the member pass)
  item.mentions?.roles?.forEach(role => {
    if (role) {
      messagetext = strReplace(messagetext, `&lt;@&amp;${role.id}&gt;`, roleMentionPill(role, templates.mention));
    }
  });

  return messagetext;
}

// ---------------------------------------------------------------------------
// buildMessagesHtml — public API
// ---------------------------------------------------------------------------

exports.buildMessagesHtml = async function buildMessagesHtml(params) {
  const {
    bot, chnl, member, discordID, req,
    imagesCookie, animationsCookie = 1,
    authorText, replyText, clientTimezone,
    channelId,
    messages: overrideMessages,
  } = params;

  // Unify template references under camelCase
  const templates = {
    message:                   TEMPLATES.message,
    messageForwarded:          TEMPLATES.messageForwarded,
    messageMentioned:          TEMPLATES.messageMentioned,
    messageForwardedMentioned: TEMPLATES.messageForwardedMentioned,
    firstMessageContent:       TEMPLATES.firstMessageContent,
    mergedMessageContent:      TEMPLATES.mergedMessageContent,
    mention:                   TEMPLATES.mention,
    fileDownload:              TEMPLATES.fileDownload,
    reactions:                 TEMPLATES.reactions,
    reaction:                  TEMPLATES.reaction,
    dateSeparator:             TEMPLATES.dateSeparator,
    messageContinuation:       TEMPLATES.messageContinuation,
  };

  const messages = overrideMessages ?? await bot.getHistoryCached(chnl);
  const memberCache = new Map();

  // Mutable rendering state
  const state = {
    lastauthor: undefined,
    lastmember: undefined,
    lastdate: new Date('1995-12-17T03:24:00'),
    lastmessagedate: null,
    currentmessage: '',
    messageid: 0,
    isForwarded: false,
    forwardData: {},
    lastMentioned: false,
    lastReply: false,
    lastReplyData: {},
    lastInteraction: false,
    lastInteractionData: {},
    isContinuationBlock: false,
    clientTimezone,
  };

  let response = '';

  const context = {
    bot, chnl, member, discordID, req,
    imagesCookie, animationsCookie, clientTimezone,
    memberCache, templates,
  };

  const shouldStartNewGroup = (item) =>
    !state.lastauthor ||
    !isSameAuthor(state.lastmember, state.lastauthor, null, item.author) ||
    item.createdAt - state.lastdate > MESSAGE_GROUP_TIMEOUT_MS ||
    (item.reference && item.reference.type !== MessageReferenceType.Forward) ||
    state.lastReply ||
    state.lastInteraction;

  const processItem = async (item) => {
    // Flush the previous group when the author changes or this is the sentinel call
    if (state.lastauthor) {
      const flushNow = !item || shouldStartNewGroup(item);
      if (flushNow) {
        response += flushMessageGroup(state, templates, authorText, replyText, channelId);
        state.currentmessage = '';
      }
    }

    if (!item) return;

    const currentMember = await ensureMemberData(item, chnl.guild, memberCache);

    // Date separator
    if (clientTimezone && areDifferentDays(item.createdAt, state.lastmessagedate, clientTimezone)) {
      const sep = templates.dateSeparator.replace('{$DATE_SEPARATOR}', formatDateSeparator(item.createdAt, clientTimezone));
      response += sep;
    }
    state.lastmessagedate = item.createdAt;

    // Resolve forward / reply metadata
    let isForwarded = false;
    let forwardData = {};
    if (item.reference?.type === MessageReferenceType.Forward) {
      const data = await resolveForwardData(item, chnl, bot, discordID, memberCache, clientTimezone, req, imagesCookie, animationsCookie);
      if (data) { isForwarded = true; forwardData = data; }
    }

    let isReply = false;
    let replyData = {};
    if (item.reference && !isForwarded) {
      const data = await resolveReplyData(item, chnl, memberCache, bot, imagesCookie, animationsCookie);
      if (data) { isReply = true; replyData = data; }
    }

    let isInteraction = false;
    let interactionData = {};
    if (item.interaction) {
      const data = await resolveInteractionData(item, chnl, memberCache);
      if (data) { isInteraction = true; interactionData = data; }
    }

    let messagetext = await renderMessageContent(item, context);

    const isMentioned = detectMention(item, member, discordID, isReply, replyData);

    // Wrap in first-message or merged template
    const startsNewGroup = !state.lastauthor ||
      !isSameAuthor(state.lastmember, state.lastauthor, currentMember, item.author) ||
      item.createdAt - state.lastdate > MESSAGE_GROUP_TIMEOUT_MS ||
      isReply ||
      isInteraction ||
      state.lastReply;

    messagetext = startsNewGroup
      ? templates.firstMessageContent.replace('{$MESSAGE_TEXT}', messagetext)
      : templates.mergedMessageContent.replace('{$MESSAGE_TEXT}', messagetext);

    // Track whether this is the first message of a continuation block (same author,
    // recent, no reply) — used by flushMessageGroup to omit the author header.
    if (state.currentmessage === '') {
      state.isContinuationBlock = !startsNewGroup;
    }

    const reactionsHtml = processReactions(item.reactions, imagesCookie, templates.reactions, templates.reaction, animationsCookie);
    const hasEmbeds = item.embeds && item.embeds.length > 0;
    const finalReactionsHtml = (hasEmbeds && reactionsHtml)
      ? reactionsHtml.replace('class="reactions"', 'class="reactions embed-reactions"')
      : reactionsHtml;
    messagetext = strReplace(messagetext, '{$MESSAGE_REACTIONS}', finalReactionsHtml);

    // System message handling
    const isSystem = !isNormalMessage(item.type);
    const visibleText = messagetext.replace(/<img\b[^>]*>/gi, 'x').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

    if (!isSystem && visibleText.length === 0 &&
        !item.attachments?.size && !item.embeds?.length && !item.stickers?.size) {
      return; // nothing to show
    }

    if (isSystem && visibleText.length === 0) {
      const systemText = SYSTEM_MESSAGE_TEXT[item.type] ?? 'performed an action';
      messagetext = `<font style="font-size:14px;color:${authorText};font-style:italic;" face="rodin,sans-serif">${systemText}</font>`;
    }

    // Advance state
    state.lastauthor        = item.author;
    state.lastmember        = currentMember;
    state.lastdate          = item.createdAt;
    state.messageid         = item.id;
    state.isForwarded       = isForwarded;
    state.forwardData       = forwardData;
    state.lastMentioned     = isMentioned;
    state.lastReply         = isReply;
    state.lastReplyData     = replyData;
    state.lastInteraction   = isInteraction;
    state.lastInteractionData = interactionData;
    state.currentmessage += messagetext;
  };

  for (const item of messages) {
    await processItem(item);
  }
  await processItem(null); // flush final group

  response = removeExistingEndAnchors(response);
  response += '<a id="end" name="end"></a>';
  return response;
};

// ---------------------------------------------------------------------------
// Theme helpers
// ---------------------------------------------------------------------------

function resolveTheme(req) {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const urlTheme  = parsedUrl.searchParams.get('theme');
  const cookieTheme = req.headers.cookie?.split('; ')
    ?.find(c => c.startsWith('whiteThemeCookie='))
    ?.split('=')[1];

  const themeValue = urlTheme !== null
    ? parseInt(urlTheme, 10)
    : (cookieTheme !== undefined ? parseInt(cookieTheme, 10) : 0);

  return THEME_CONFIG[themeValue] ?? THEME_CONFIG[0];
}

function resolvePreferences(req) {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const urlSessionID = parsedUrl.searchParams.get('sessionID') ?? '';
  const urlTheme     = parsedUrl.searchParams.get('theme');
  const urlImages    = parsedUrl.searchParams.get('images');

  const cookieImages = req.headers.cookie?.split('; ')
    ?.find(c => c.startsWith('images='))
    ?.split('=')[1];
  const cookieTheme = req.headers.cookie?.split('; ')
    ?.find(c => c.startsWith('whiteThemeCookie='))
    ?.split('=')[1];

  const imagesCookie = urlImages !== null
    ? parseInt(urlImages, 10)
    : (cookieImages !== undefined ? parseInt(cookieImages, 10) : 1);

  const linkParamParts = [];
  if (urlSessionID) linkParamParts.push('sessionID=' + encodeURIComponent(urlSessionID));
  if (urlTheme !== null && cookieTheme === undefined) linkParamParts.push('theme=' + encodeURIComponent(urlTheme));
  if (urlImages !== null && cookieImages === undefined) linkParamParts.push('images=' + encodeURIComponent(urlImages));
  const sessionParam = linkParamParts.length ? '?' + linkParamParts.join('&') : '';

  return { urlSessionID, imagesCookie, sessionParam };
}

// ---------------------------------------------------------------------------
// Input template selection
// ---------------------------------------------------------------------------

function buildInputHtml(botMember, member, chnl, boxColor) {
  const canWebhook = botMember.permissionsIn(chnl).has(PermissionFlagsBits.ManageWebhooks, true);
  const canSend    = member.permissionsIn(chnl).has(PermissionFlagsBits.SendMessages, true);

  if (!canWebhook) {
    let html = strReplace(TEMPLATES.inputDisabled, '{$COLOR}', boxColor);
    html = strReplace(html, "You don't have permission to send messages in this channel.", "Discross bot doesn't have the Manage Webhooks permission");
    return html;
  }
  if (canSend) {
    return strReplace(TEMPLATES.input, '{$COLOR}', boxColor);
  }
  return strReplace(TEMPLATES.inputDisabled, '{$COLOR}', boxColor);
}

// ---------------------------------------------------------------------------
// processChannel — public API
// ---------------------------------------------------------------------------

exports.processChannel = async function processChannel(bot, req, res, args, discordID) {
  const { urlSessionID, imagesCookie, sessionParam } = resolvePreferences(req);
  const theme = resolveTheme(req);

  const template = strReplace(TEMPLATES.channel, '{$WHITE_THEME_ENABLED}', theme.themeClass);
  const { authorText, replyText, boxColor } = theme;

  const isReady = bot?.client && (typeof bot.client.isReady === 'function' ? bot.client.isReady() : !!bot.client.uptime);
  if (!isReady) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end("The bot isn't connected, try again in a moment");
    return;
  }

  const clientTimezone = getTimezoneFromIP(getClientIP(req));

  let chnl;
  try {
    chnl = await bot.client.channels.fetch(args[2]);
  } catch {
    chnl = undefined;
  }

  if (!chnl) {
    return notFound.serve404(req, res, 'Invalid channel.', '/', 'Back to Home');
  }

  try {
    let botMember, member;

    try {
      botMember = await chnl.guild.members.fetch(bot.client.user.id);
    } catch {
      res.end('The bot is not in this server!');
      return;
    }

    try {
      member = await chnl.guild.members.fetch(discordID);
    } catch {
      res.end('You are not in this server! Please join the server to view this channel.');
      return;
    }

    const canView = member.permissionsIn(chnl).has(PermissionFlagsBits.ViewChannel, true)
                 && botMember.permissionsIn(chnl).has(PermissionFlagsBits.ViewChannel, true);

    if (!canView) {
      res.end("You (or the bot) don't have permission to do that!");
      return;
    }

    const baseTemplate = strReplace(strReplace(template, '{$SERVER_ID}', chnl.guild.id), '{$CHANNEL_ID}', chnl.id);
    const inputHtml = buildInputHtml(botMember, member, chnl, boxColor);

    // No message history permission
    if (!member.permissionsIn(chnl).has(PermissionFlagsBits.ReadMessageHistory, true)) {
      let final = strReplace(baseTemplate, '{$INPUT}', inputHtml);
      final = strReplace(final, '{$MESSAGES}', TEMPLATES.noMessageHistory);
      final = strReplace(final, '{$CHANNEL_NAME}', (chnl.isThread() ? '' : '#') + normalizeWeirdUnicode(chnl.name));
      final = strReplace(final, '{$SESSION_ID}', urlSessionID);
      final = strReplace(final, '{$SESSION_PARAM}', sessionParam);
      res.write(final);
      res.end();
      return;
    }

    console.log('Processed valid channel request');

    const messagesHtml = await exports.buildMessagesHtml({
      bot, chnl, member, discordID, req,
      imagesCookie, animationsCookie: 1,
      authorText, replyText, clientTimezone,
      channelId: args[2],
      // Templates are now sourced internally; kept for backward-compat signature
      templates: {
        message: TEMPLATES.message,
        message_forwarded: TEMPLATES.messageForwarded,
        message_mentioned: TEMPLATES.messageMentioned,
        message_forwarded_mentioned: TEMPLATES.messageForwardedMentioned,
        first_message_content: TEMPLATES.firstMessageContent,
        merged_message_content: TEMPLATES.mergedMessageContent,
        mention: TEMPLATES.mention,
        file_download: TEMPLATES.fileDownload,
        reactions: TEMPLATES.reactions,
        reaction: TEMPLATES.reaction,
        date_separator: TEMPLATES.dateSeparator,
      },
    });

    const randomEmoji = RANDOM_EMOJIS[Math.floor(Math.random() * RANDOM_EMOJIS.length)];
    const refreshUrl = chnl.id + '?random=' + Math.random() + (urlSessionID ? '&sessionID=' + encodeURIComponent(urlSessionID) : '');

    let final = strReplace(baseTemplate, '{$REFRESH_URL}', refreshUrl);
    final = strReplace(final, '{$INPUT}',        inputHtml);
    final = strReplace(final, '{$RANDOM_EMOJI}', randomEmoji);
    final = strReplace(final, '{$CHANNEL_NAME}', (chnl.isThread() ? '' : '#') + normalizeWeirdUnicode(chnl.name));
    final = strReplace(final, '{$MESSAGES}',     messagesHtml);
    final = strReplace(final, '{$SESSION_ID}',   urlSessionID);
    final = strReplace(final, '{$SESSION_PARAM}',sessionParam);

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(final);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end('An error occurred! Please try again later.');
  }
};
