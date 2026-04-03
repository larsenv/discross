'use strict';

const fs = require('fs');
const escape = require('escape-html');
const he = require('he');
const { PermissionFlagsBits, MessageReferenceType } = require('discord.js');
const { renderDiscordMarkdown } = require('./discordMarkdown');
const { getDisplayName, getMemberColor, ensureMemberData } = require('./memberUtils');
const {
  getClientIP,
  getTimezoneFromIP,
  formatDateWithTimezone,
  formatDateSeparator,
  areDifferentDays,
  formatForwardedTimestamp,
  replaceDiscordTimestamps,
} = require('../timezoneUtils');
const { processEmbeds } = require('./embedUtils');
const { processReactions } = require('./reactionUtils');
const { processPoll } = require('./pollUtils');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const { unicodeToTwemojiCode, cacheCustomEmoji } = require('./emojiUtils');
const emojiRegex = require('./twemojiRegex').regex;
const notFound = require('./notFound.js');
const {
  isBotReady,
  parseCookies,
  resolveTheme,
  RANDOM_EMOJIS,
  buildSessionParam,
  buildEmojiToggleUrl,
  getTemplate,
  renderTemplate,
} = require('./utils.js');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FORWARDED_CONTENT_MAX_LENGTH = 100;
const REPLY_CONTENT_MAX_LENGTH = 25;
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const chars = Array.from(text);
  return chars.length > maxLength ? chars.slice(0, maxLength).join('') + '...' : text;
}

function isSameAuthor(member1, author1, member2, author2) {
  if (member1 && member2) return member1.user.id === member2.user.id;
  if (author1 && author2) return author1.id === author2.id && author1.username === author2.username;
  return false;
}

function isNormalMessage(type) {
  return type === 0 || type === 19;
}

// ---------------------------------------------------------------------------
// Rendering Components
// ---------------------------------------------------------------------------

function renderEmojis(messagetext, item, imagesCookie, animationsCookie) {
  if (imagesCookie !== 1) return messagetext;

  const customEmojiRegex = /<a?:.+?:\d{16,20}>/g;
  const customMatches = item.content.match(customEmojiRegex) ?? [];
  const unicodeMatches = item.content.match(emojiRegex) ?? [];
  const totalEmojis = customMatches.length + unicodeMatches.length;
  const stripped = item.content.replace(customEmojiRegex, '').replace(emojiRegex, '').trim();
  const isJumbo = stripped.length === 0 && totalEmojis > 0 && totalEmojis <= 29;

  const size = isJumbo ? '2.75em' : '1.375em';
  const px = isJumbo ? 44 : 22;
  const imgStyle = `width: ${size}; height: ${size}; vertical-align: -0.2em;`;

  const tmpl_twemoji = getTemplate('emoji_twemoji', 'channel');
  const tmpl_custom = getTemplate('emoji_custom', 'channel');

  let result = messagetext;

  // Unicode emoji
  result = result.replace(emojiRegex, (match) => {
    const code = unicodeToTwemojiCode(match);
    return renderTemplate(tmpl_twemoji, {
      CODE: code,
      PX: px.toString(),
      STYLE: imgStyle,
    });
  });

  // Custom emoji
  const customMatchesIterator = result.matchAll(/&lt;(:)?(?:(a):)?(\w{2,32}):(\d{16,20})?(?:(?!\1).)*&gt;/g);
  for (const match of customMatchesIterator) {
    const animated = !!match[2];
    const ext = animated && animationsCookie === 1 ? 'gif' : 'png';
    cacheCustomEmoji(match[4], match[3], animated);
    result = result.split(match[0]).join(
      renderTemplate(tmpl_custom, {
        EMOJI_ID: match[4],
        EXT: ext,
        PX: px.toString(),
        STYLE: imgStyle,
      })
    );
  }

  return result;
}

function renderAttachments(messagetext, item, imagesCookie, tmpl_file_download) {
  let result = messagetext || '';
  const attachments = item?.attachments;
  if (!attachments) return result;
  
  const list = attachments.values ? Array.from(attachments.values()) : attachments;
  if (list.length === 0) return result;

  const tmpl_spoiler = getTemplate('spoiler_image', 'channel');
  const tmpl_normal_image = getTemplate('normal_image', 'channel');

  const IMAGE_EXT = /\.(jpg|gif|png|jpeg|avif|svg|webp|tif|tiff)$/i;
  const VIDEO_EXT = /\.(mp4|webm|mov|avi|mkv)$/i;
  const imageData = [];

  for (const attachment of list) {
    if (!attachment) continue;
    const isImage = IMAGE_EXT.test(attachment.name);
    const isVideo = VIDEO_EXT.test(attachment.name);
    const isSpoiler = attachment.name?.toUpperCase().startsWith('SPOILER_');
    const proxyBase = isImage && imagesCookie === 1 ? '/imageProxy/' : '/fileProxy/';
    const url = proxyBase + (attachment.url || '').replace(/^(.*?)(\d+)/, '$2');

    if (isImage && imagesCookie === 1) {
      imageData.push({ url, isSpoiler });
    } else {
      const card = renderTemplate(tmpl_file_download, {
        '{$FILE_NAME}': truncateFileName(attachment.name || 'file'),
        '{$FILE_SIZE}': formatFileSize(attachment.size || 0),
        '{$FILE_LINK}': !isVideo || imagesCookie !== 1 ? url : '{$FILE_LINK}',
      });
      result = (result ? result + '<br>' : '') + card;
    }
  }

  for (const data of imageData) {
    const imgHtml = data.isSpoiler
      ? renderTemplate(tmpl_spoiler, { IMAGE_URL: data.url })
      : renderTemplate(tmpl_normal_image, { IMAGE_URL: data.url });
    result += imgHtml;
  }

  return result;
}

function renderStickers(messagetext, item, imagesCookie) {
  let result = messagetext || '';
  const stickers = item?.stickers;
  if (!stickers) return result;
  
  const list = stickers.values ? Array.from(stickers.values()) : stickers;
  if (list.length === 0) return result;

  const tmpl_sticker = getTemplate('sticker', 'channel');
  const tmpl_sticker_text = getTemplate('sticker_text', 'channel');

  for (const sticker of list) {
    if (!sticker) continue;
    const sep = result ? '<br>' : '';
    if (imagesCookie === 1) {
      result += sep + renderTemplate(tmpl_sticker, { STICKER_ID: sticker.id });
    } else {
      result += sep + renderTemplate(tmpl_sticker_text, { STICKER_NAME: escape(sticker.name ?? 'Unknown') });
    }
  }

  return result;
}

function buildProxiedImageTag(rawUrl, alt, style = 'max-width:256px;max-height:200px;height:auto;') {
  const proxied = `/imageProxy/external/${Buffer.from(rawUrl).toString('base64')}`;
  const tag = renderTemplate(getTemplate('image_tag', 'channel'), {
    IMAGE_SRC: proxied,
    CLASS: style,
    IMAGE_ALT: alt,
  });
  return { proxied, tag };
}

function replaceOrAppendMedia(messagetext, embedUrl, imgHtml) {
  let result = messagetext || '';
  if (embedUrl) {
    const escaped = embedUrl.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const escapedEncoded = embedUrl.replace(/&/g, '&amp;').replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const re = new RegExp(`<a\\s+[^>]*href=["'](?:${escaped}|${escapedEncoded})["'][^>]*>[^<]*</a>`, 'ig');
    if (re.test(result)) return result.replace(re, imgHtml);
  }
  return (result ? result + '<br>' : '') + imgHtml;
}

function renderEmbeds(messagetext, item, req, imagesCookie, animationsCookie, clientTimezone) {
  let result = messagetext || '';
  if (!item?.embeds?.length) return result;

  const richEmbeds = [];

  for (const embed of item.embeds) {
    if (!embed) continue;
    const isTenor = (embed.provider?.name === 'Tenor' || urlMatchesDomain(embed.url, 'tenor.com')) && embed.thumbnail?.url;
    const isGiphy = (embed.provider?.name === 'GIPHY' || urlMatchesDomain(embed.url, 'giphy.com')) && (embed.thumbnail?.url || embed.image?.url);
    const isYouTube = embed.provider?.name === 'YouTube' || urlMatchesDomain(embed.url, 'youtube.com') || urlMatchesDomain(embed.url, 'youtu.be');

    if (imagesCookie !== 1) {
      if (!isTenor && !isGiphy) {
        if (isYouTube) {
          richEmbeds.push({
            color: 0xfd001b,
            author: embed.author,
            title: embed.title,
            url: embed.url,
            description: embed.description,
            fields: embed.fields,
            image: embed.image,
            thumbnail: embed.thumbnail,
            footer: embed.footer,
            timestamp: embed.timestamp,
            data: embed.data,
          });
        } else {
          richEmbeds.push(embed);
        }
      }
      continue;
    }

    if (isTenor) {
      result = replaceOrAppendMedia(result, embed.url, buildProxiedImageTag(embed.thumbnail.url, 'Tenor GIF').tag);
    } else if (isGiphy) {
      const rawUrl = embed.image?.url ?? embed.thumbnail?.url;
      if (rawUrl) result = replaceOrAppendMedia(result, embed.url, buildProxiedImageTag(rawUrl, 'GIPHY GIF').tag);
    } else if (isYouTube) {
      richEmbeds.push({ color: 0xfd001b, author: embed.author, title: embed.title, url: embed.url, description: embed.description, fields: embed.fields, image: embed.image ?? embed.thumbnail, thumbnail: null, footer: embed.footer, timestamp: embed.timestamp, data: embed.data });
    } else if (embed.data?.type === 'poll_result') {
      result = (result ? result + '<br>' : '') + renderPollResultEmbed(embed);
    } else if (embed.data?.type === 'image' || embed.data?.type === 'gifv') {
      const rawUrl = embed.thumbnail?.url ?? embed.image?.url;
      if (rawUrl) result = replaceOrAppendMedia(result, embed.url, buildProxiedImageTag(rawUrl, 'Image').tag);
    } else {
      richEmbeds.push(embed);
    }
  }

  if (richEmbeds.length > 0) {
    result += processEmbeds(req, richEmbeds, imagesCookie, animationsCookie, clientTimezone);
  }

  return result;
}

function renderPollResultEmbed(embed) {
  const fieldMap = {};
  (embed.fields ?? []).forEach((f) => { fieldMap[f.name] = f.value; });
  const question = fieldMap['poll_question_text'] ?? '';
  const winnerText = fieldMap['victor_answer_text'] ?? '';
  const winnerEmoji = fieldMap['victor_answer_emoji_name'] ?? '';
  const winnerVotes = fieldMap['victor_answer_votes'] ?? '0';
  const totalVotes = fieldMap['total_votes'] ?? '0';
  const emojiPart = winnerEmoji ? escape(winnerEmoji) + ' ' : '';

  return renderTemplate(getTemplate('poll_result', 'channel'), {
    QUESTION: escape(question),
    WINNER_EMOJI: emojiPart,
    WINNER_TEXT: escape(winnerText),
    WINNER_VOTES: escape(winnerVotes),
    TOTAL_VOTES: escape(totalVotes),
  });
}

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

function roleMentionPill(role, tmpl_mention) {
  const name = escape('@' + normalizeWeirdUnicode(role.name));
  if (role.color !== 0) {
    const hex = role.hexColor;
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return renderTemplate(getTemplate('role_mention_colored', 'channel'), { HEX: hex, R: r.toString(), G: g.toString(), B: b.toString(), NAME: name });
  }
  return renderTemplate(getTemplate('role_mention_plain', 'channel'), { NAME: name });
}

function renderKnownMentions(messagetext, item, discordID, member, templates) {
  let result = messagetext;
  if (!item.mentions) return result;

  const members = item.mentions.members?.values ? Array.from(item.mentions.members.values()) : (item.mentions.members || []);
  if (Array.isArray(members)) {
    for (const user of members) {
      if (!user) continue;
      const tmpl = (user.id === discordID) ? templates.mentionHighlighted : templates.mention;
      const pill = renderTemplate(tmpl, { '{$USERNAME}': escape('@' + normalizeWeirdUnicode(user.displayName)) });
      result = result.split(`&lt;@${user.id}&gt;`).join(pill);
      result = result.split(`&lt;@!${user.id}&gt;`).join(pill);
    }
  }

  if (item.mentions.roles) {
    const roles = item.mentions.roles.values ? Array.from(item.mentions.roles.values()) : item.mentions.roles;
    if (Array.isArray(roles)) {
      for (const role of roles) {
        if (!role) continue;
        const tmpl = (member && member.roles.cache?.has(role.id)) ? templates.mentionHighlighted : templates.mention;
        result = result.split(`&lt;@&amp;${role.id}&gt;`).join(roleMentionPill(role, tmpl));
      }
    }
  }

  return result;
}

async function resolveRemainingMentions(messagetext, chnl, memberCache, tmpl_mention) {
  const unresolvedIds = [...messagetext.matchAll(/&lt;@!?(\d{16,20})&gt;/g)].map((m) => m[1]).filter((id) => !memberCache.has(id));
  await Promise.allSettled(unresolvedIds.map(async (id) => {
    try { memberCache.set(id, await chnl.guild.members.fetch(id)); } catch { memberCache.set(id, null); }
  }));
  return messagetext.replace(/&lt;@!?(\d{16,20})&gt;/g, (match, userId) => {
    const resolved = memberCache.get(userId) ?? chnl.guild.members.cache.get(userId);
    return resolved ? renderTemplate(tmpl_mention, { '{$USERNAME}': escape('@' + normalizeWeirdUnicode(getDisplayName(resolved, resolved.user))) }) : renderTemplate(tmpl_mention, { '{$USERNAME}': '@unknown-user' });
  });
}

async function resolveChannelMentions(messagetext, bot, chnl) {
  const unresolvedIds = [...messagetext.matchAll(/&lt;#(\d{16,20})&gt;/g)].map((m) => m[1]).filter((id) => !bot.client.channels.cache.has(id));
  await Promise.allSettled(unresolvedIds.map(async (id) => { try { await bot.client.channels.fetch(id); } catch {} }));
  return messagetext.replace(/&lt;#(\d{16,20})&gt;/g, (match, id) => {
    const { ChannelType } = require('discord.js');
    const ch = bot.client.channels.cache.get(id);
    if (!ch) return match;
    if (ch.type === ChannelType.GuildForum || ch.type === ChannelType.GuildMedia) return '#' + escape(normalizeWeirdUnicode(ch.name));
    return renderTemplate(getTemplate('channel_mention', 'channel'), { CHANNEL_URL: `/channels/${ch.id}`, CHANNEL_NAME: escape(normalizeWeirdUnicode(ch.name)) });
  });
}

function renderEveryoneMentions(messagetext, item, templates) {
  if (!item.mentions?.everyone) return messagetext;
  const tmpl = templates.mention;
  let result = messagetext;
  if (result.includes('@everyone')) result = result.split('@everyone').join(renderTemplate(tmpl, { '{$USERNAME}': '@everyone' }));
  if (result.includes('@here')) result = result.split('@here').join(renderTemplate(tmpl, { '{$USERNAME}': '@here' }));
  return result;
}

function detectMention(item, member, discordID, isReply, replyData) {
  if (item.mentions?.members?.has?.(discordID) || (Array.isArray(item.mentions?.members) && item.mentions.members.some(m => m.id === discordID))) {
    if (isReply && item.author?.id === discordID && replyData?.authorId === discordID) {
      const mentionRegex = new RegExp(`<@!?${discordID}>`);
      if (!mentionRegex.test(item.content)) return false;
    }
    return true;
  }
  if (isReply && replyData.mentionsPing && replyData.authorId === discordID) return true;
  if (item.mentions?.everyone) return true;
  if (item.mentions?.roles && member) {
    const roles = item.mentions.roles.values ? Array.from(item.mentions.roles.values()) : item.mentions.roles;
    if (Array.isArray(roles)) {
      for (const role of roles) { if (role && member.roles.cache?.has(role.id)) return true; }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Group Metadata Resolution
// ---------------------------------------------------------------------------

async function resolveForwardData(item, chnl, bot, discordID, memberCache, clientTimezone, req, imagesCookie, animationsCookie, barColor) {
  try {
    const fwdMsg = await item.fetchReference();
    const fwdMember = fwdMsg.author?.bot ? null : await ensureMemberData(fwdMsg, chnl.guild, memberCache);
    const originHtml = await (async () => {
      if (!fwdMsg.guildId || !fwdMsg.channelId || !fwdMsg.id) return '';
      const fwdChannel = fwdMsg.channel ?? bot.client.channels.cache.get(fwdMsg.channelId);
      if (!fwdChannel) return '';
      const chanLink = renderTemplate(getTemplate('forwarded_same_server', 'channel'), { JUMP_LINK: `/channels/${fwdMsg.channelId}/${fwdMsg.id}`, CHANNEL_NAME: escape(normalizeWeirdUnicode(fwdChannel.name)), TIME_DISPLAY: formatForwardedTimestamp(fwdMsg.createdAt, clientTimezone) });
      if (fwdMsg.guildId === chnl.guild.id) return renderTemplate(getTemplate('forwarded_content_block_label', 'channel'), { CONTENT: chanLink });
      const otherGuild = bot.client.guilds.cache.get(fwdMsg.guildId);
      if (!otherGuild) return '';
      await otherGuild.members.fetch(discordID);
      return renderTemplate(getTemplate('forwarded_other_server', 'channel'), { GUILD_NAME: escape(normalizeWeirdUnicode(otherGuild.name)), CONTENT: chanLink });
    })().catch(() => '');
    const snapshotMsg = item.messageSnapshots?.first();
    const embedsHtml = renderEmbeds('', fwdMsg.embeds?.length ? fwdMsg : (snapshotMsg ?? fwdMsg), req, imagesCookie, animationsCookie, clientTimezone);
    return { author: getDisplayName(fwdMember, fwdMsg.author), content: renderDiscordMarkdown(truncateText(fwdMsg.content, FORWARDED_CONTENT_MAX_LENGTH), { barColor }), date: formatDateWithTimezone(fwdMsg.createdAt, clientTimezone), origin: originHtml, embeds: embedsHtml };
  } catch {
    const snapshotMsg = item.messageSnapshots?.first();
    if (!snapshotMsg) return null;
    return { author: getDisplayName(null, snapshotMsg.author) || '', content: renderDiscordMarkdown(truncateText(snapshotMsg.content ?? '', FORWARDED_CONTENT_MAX_LENGTH), { barColor }), date: snapshotMsg.createdAt ? formatDateWithTimezone(snapshotMsg.createdAt, clientTimezone) : '', origin: '', embeds: renderEmbeds('', snapshotMsg, req, imagesCookie, animationsCookie, clientTimezone) };
  }
}

async function resolveRawMentionsForPreview(text, msg, memberCache, chnl, bot) {
  const members = msg.mentions?.members?.values ? Array.from(msg.mentions.members.values()) : (msg.mentions?.members || []);
  if (Array.isArray(members)) { for (const m of members) { if (!m) continue; const name = '@' + normalizeWeirdUnicode(getDisplayName(m, m.user)); text = text.split(`<@${m.id}>`).join(name); text = text.split(`<@!${m.id}>`).join(name); } }
  const roles = msg.mentions?.roles?.values ? Array.from(msg.mentions.roles.values()) : (msg.mentions?.roles || []);
  if (Array.isArray(roles)) { for (const r of roles) { if (!r) continue; text = text.split(`<@&${r.id}>`).join('@' + normalizeWeirdUnicode(r.name)); } }
  const unresolvedUserIds = [...text.matchAll(/<@!?(\d{16,20})>/g)].map((m) => m[1]).filter((id) => !memberCache.has(id));
  await Promise.allSettled(unresolvedUserIds.map(async (id) => { try { memberCache.set(id, await chnl.guild.members.fetch(id)); } catch { memberCache.set(id, null); } }));
  text = text.replace(/<@!?(\d{16,20})>/g, (match, id) => { const cached = memberCache.get(id) ?? chnl.guild.members.cache.get(id); return cached ? '@' + normalizeWeirdUnicode(getDisplayName(cached, cached.user)) : match; });
  const unresolvedChannelIds = [...text.matchAll(/<#(\d{16,20})>/g)].map((m) => m[1]).filter((id) => !bot.client.channels.cache.has(id));
  await Promise.allSettled(unresolvedChannelIds.map(async (id) => { try { await bot.client.channels.fetch(id); } catch {} }));
  text = text.replace(/<#(\d{16,20})>/g, (match, id) => { const ch = bot.client.channels.cache.get(id); return ch ? '#' + normalizeWeirdUnicode(ch.name) : match; });
  return text;
}

async function resolveReplyData(item, chnl, memberCache, bot, imagesCookie, animationsCookie, barColor, authorText) {
  try {
    const replyMessage = await item.fetchReference().catch(() => null);
    const replyUser = replyMessage?.author ?? item.mentions?.repliedUser;
    const replyMember = await (async () => {
      if (replyMessage) return replyMessage.author?.bot ? null : await ensureMemberData(replyMessage, chnl.guild, memberCache);
      if (!replyUser?.id) return undefined;
      if (memberCache.has(replyUser.id)) return memberCache.get(replyUser.id);
      return chnl.guild.members.fetch(replyUser.id).then((m) => { memberCache.set(replyUser.id, m); return m; }).catch(() => undefined);
    })();
    const replyContent = replyMessage?.content ? await (async () => { const resolvedFlat = await resolveRawMentionsForPreview(replyMessage.content.replace(/\r?\n/g, ' ').replace(/  +/g, ' ').trim(), replyMessage, memberCache, chnl, bot); return truncateText(resolvedFlat.replace(/^(>>?>?\s*)+/, ''), REPLY_CONTENT_MAX_LENGTH); })() : '';
    return { author: getDisplayName(replyMember, replyUser), authorId: replyUser?.id, authorColor: getMemberColor(replyMember, authorText), mentionsPing: item.mentions?.repliedUser !== null && item.mentions?.repliedUser !== undefined && item.author?.id !== replyUser?.id, content: replyContent };
  } catch (err) { console.error('Could not process reply data:', err); return null; }
}

function buildReplyIndicator(replyData, replyText, barColor = '#808080') {
  const normalizedReplyContent = (replyData.content || '').replace(/<br[^>]*>/gi, ' ').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  const contentTd = normalizedReplyContent ? renderTemplate(getTemplate('reply_content_cell', 'channel'), { REPLY_TEXT_TOP_OFFSET: '-1', REPLY_TEXT: replyText, REPLY_PREVIEW: he.encode(normalizedReplyContent, { useNamedReferences: true }) }) : '';
  return '<table cellpadding="0" cellspacing="0" style="margin-bottom:4px;line-height:1">' + renderTemplate(getTemplate('reply_with_content', 'channel'), { BAR_COLOR: barColor, REPLY_TEXT_TOP_OFFSET: '-1', AUTHOR_COLOR: replyData.authorColor, AT_SIGN: replyData.mentionsPing ? '@' : '', AUTHOR_NAME: escape(replyData.author), CONTENT_TD: contentTd }) + '</table>';
}

async function resolveInteractionData(item, chnl, memberCache, authorText) {
  try {
    const user = item.interaction?.user; if (!user) return null;
    const cached = memberCache.get(user.id);
    const member = cached !== undefined ? cached : await chnl.guild.members.fetch(user.id).then((m) => { memberCache.set(user.id, m); return m; }).catch(() => undefined);
    return { author: getDisplayName(member, user), authorColor: getMemberColor(member, authorText), commandName: item.interaction.commandName };
  } catch (err) { console.error('Could not process interaction data:', err); return null; }
}

function buildInteractionIndicator(interactionData, textColor, barColor = '#808080') {
  return '<table cellpadding="0" cellspacing="0" style="margin-bottom:4px"><tr>' + renderTemplate(getTemplate('interaction_indicator', 'channel'), { BAR_COLOR: barColor, AUTHOR_COLOR: interactionData.authorColor, AUTHOR_NAME: escape(interactionData.author), TEXT_COLOR: textColor, COMMAND_NAME: escape(interactionData.commandName) }) + '</tr></table>';
}

// ---------------------------------------------------------------------------
// Flushing and Grouping
// ---------------------------------------------------------------------------

function flushMessageGroup(state, templates, authorText, replyText, barColor, channelId) {
  const replyLink = channelId ? `/channels/${channelId}/${state.messageid}` : 'javascript:void(0)';
  const baseHtml = (() => {
    if (state.isContinuationBlock && !state.isForwarded && !state.lastMentioned) return renderTemplate(templates.messageContinuation, { '{$MESSAGE_CONTENT}': state.currentmessage });
    if (state.isForwarded && state.lastMentioned) return renderTemplate(templates.messageForwardedMentioned, { '{$MESSAGE_CONTENT}': state.currentmessage, '{$MESSAGE_REPLY_LINK}': replyLink });
    if (state.isForwarded) return renderTemplate(templates.messageForwarded, { '{$MESSAGE_CONTENT}': state.currentmessage, '{$MESSAGE_REPLY_LINK}': replyLink });
    if (state.lastMentioned) return renderTemplate(templates.messageMentioned, { '{$MESSAGE_CONTENT}': state.currentmessage, '{$MESSAGE_REPLY_LINK}': replyLink });
    return renderTemplate(templates.message, { '{$MESSAGE_CONTENT}': state.currentmessage, '{$MESSAGE_REPLY_LINK}': replyLink });
  })();
  const contentBlock = state.isForwarded && state.forwardData.content ? renderTemplate(getTemplate('forwarded_content_block', 'channel'), { CONTENT: state.forwardData.content }) : '';
  const afterForwarded = state.isForwarded ? renderTemplate(baseHtml, { '{$FORWARDED_AUTHOR}': escape(state.forwardData.author), '{$FORWARDED_CONTENT_BLOCK}': contentBlock, '{$FORWARDED_DATE}': state.forwardData.date, '{$FORWARDED_EMBEDS}': state.forwardData.embeds ?? '', '{$FORWARDED_ORIGIN}': state.forwardData.origin ?? '' }) : baseHtml;
  const authorColor = getMemberColor(state.lastmember, authorText);
  const replyIndicator = state.lastReply ? buildReplyIndicator(state.lastReplyData, replyText, barColor) : (state.lastInteraction ? buildInteractionIndicator(state.lastInteractionData, replyText, barColor) : '');
  return renderTemplate(afterForwarded, { '{$MESSAGE_AUTHOR}': escape(getDisplayName(state.lastmember, state.lastauthor)), '{$AUTHOR_COLOR}': authorColor, '{$REPLY_INDICATOR}': replyIndicator, '{$PING_INDICATOR}': '', '{$MESSAGE_DATE}': formatDateWithTimezone(state.lastdate, state.clientTimezone), '{$TAG}': he.encode(JSON.stringify(`<@${state.lastauthor.id}>`)) });
}

async function renderMessageContent(item, context) {
  const { bot, chnl, member, discordID, req, imagesCookie, animationsCookie, clientTimezone, memberCache, templates, barColor } = context;
  const withMarkdown = renderDiscordMarkdown(item.content || '', { barColor, timezone: clientTimezone });
  const withDiscordTimestamps = replaceDiscordTimestamps(withMarkdown, clientTimezone);
  const withEmojis = renderEmojis(withDiscordTimestamps, item, imagesCookie, animationsCookie);
  const withAttachments = renderAttachments(withEmojis, item, imagesCookie, templates.fileDownload);
  const withStickers = renderStickers(withAttachments, item, imagesCookie);
  const withEmbeds = renderEmbeds(withStickers, item, req, imagesCookie, animationsCookie, clientTimezone);
  const withPoll = item?.poll ? withEmbeds + processPoll(item.poll, imagesCookie) : withEmbeds;
  const withKnownMentions = renderKnownMentions(withPoll, item, discordID, member, templates);
  const withRemainingMentions = await resolveRemainingMentions(withKnownMentions, chnl, memberCache, templates.mention);
  const withChannelMentions = await resolveChannelMentions(withRemainingMentions, bot, chnl);
  const withEveryoneMentions = renderEveryoneMentions(withChannelMentions, item, templates);
  let withRoleMentions = withEveryoneMentions;
  if (item.mentions?.roles) {
    const roles = item.mentions.roles.values ? Array.from(item.mentions.roles.values()) : item.mentions.roles;
    if (Array.isArray(roles)) { for (const role of roles) { if (!role) continue; const hasRole = (member && member.roles.cache?.has(role.id)); const tmpl = hasRole ? templates.mentionHighlighted : templates.mention; withRoleMentions = withRoleMentions.split(`&lt;@&amp;${role.id}&gt;`).join(roleMentionPill(role, tmpl)); } }
  }
  return withRoleMentions;
}

// ---------------------------------------------------------------------------
// Main Public APIs
// ---------------------------------------------------------------------------

exports.buildMessagesHtml = async function buildMessagesHtml(params) {
  const { bot, chnl, member, discordID, req, imagesCookie, animationsCookie = 1, authorText, replyText, barColor = '#808080', clientTimezone, channelId, messages: overrideMessages, templates: overrideTemplates } = params;
  const templates = overrideTemplates ?? { message: getTemplate('message', 'message'), messageForwarded: getTemplate('forwarded_message', 'message'), messageMentioned: getTemplate('message_mentioned', 'message'), messageForwardedMentioned: getTemplate('forwarded_message_mentioned', 'message'), firstMessageContent: getTemplate('first_message_content', 'message'), mergedMessageContent: getTemplate('merged_message_content', 'message'), mention: getTemplate('mention', 'message'), mentionHighlighted: getTemplate('mention_highlighted', 'message'), fileDownload: getTemplate('file_download', 'channel'), reactions: getTemplate('reactions', 'message'), reaction: getTemplate('reaction', 'message'), dateSeparator: getTemplate('date_separator', 'message'), messageContinuation: getTemplate('message_continuation', 'message') };
  const messages = overrideMessages ?? (await bot.getHistoryCached(chnl));
  const memberCache = new Map();
  const context = { bot, chnl, member, discordID, req, imagesCookie, animationsCookie, clientTimezone, memberCache, templates, barColor };
  let response = '';
  const state = { lastauthor: undefined, lastmember: undefined, lastdate: new Date('1995-12-17T03:24:00'), lastmessagedate: null, currentmessage: '', messageid: 0, isForwarded: false, forwardData: {}, lastMentioned: false, lastReply: false, lastReplyData: {}, lastForwarded: false, lastInteraction: false, lastInteractionData: {}, isContinuationBlock: false, clientTimezone };

  const shouldStartNewGroup = (item) => !state.lastauthor || !isSameAuthor(state.lastmember, state.lastauthor, null, item.author) || item.createdAt - state.lastdate > MESSAGE_GROUP_TIMEOUT_MS || !!item.reference || state.lastReply || state.lastInteraction || state.lastForwarded;

  for (const item of [...messages, null]) {
    if (state.lastauthor) { if (!item || shouldStartNewGroup(item)) { response += flushMessageGroup(state, templates, authorText, replyText, barColor, channelId); state.currentmessage = ''; } }
    if (!item) break;
    const currentMember = await ensureMemberData(item, chnl.guild, memberCache);
    if (clientTimezone && areDifferentDays(item.createdAt, state.lastmessagedate, clientTimezone)) response += renderTemplate(templates.dateSeparator, { '{$DATE_SEPARATOR}': formatDateSeparator(item.createdAt, clientTimezone) });
    state.lastmessagedate = item.createdAt;
    const fwdData = (item.reference?.type === MessageReferenceType.Forward) ? await resolveForwardData(item, chnl, bot, discordID, memberCache, clientTimezone, req, imagesCookie, animationsCookie, barColor) : null;
    const isForwarded = fwdData !== null, forwardData = fwdData ?? {};
    const rplyData = (item.reference && !isForwarded) ? await resolveReplyData(item, chnl, memberCache, bot, imagesCookie, animationsCookie, barColor, authorText) : null;
    const isReply = rplyData !== null, replyData = rplyData ?? {};
    const intData = item.interaction ? await resolveInteractionData(item, chnl, memberCache, authorText) : null;
    const isInteraction = intData !== null, interactionData = intData ?? {};
    const rawText = await renderMessageContent(item, context);
    const isMentioned = detectMention(item, member, discordID, isReply, replyData);
    const startsNewGroup = !state.lastauthor || !isSameAuthor(state.lastmember, state.lastauthor, currentMember, item.author) || item.createdAt - state.lastdate > MESSAGE_GROUP_TIMEOUT_MS || isReply || isInteraction || state.lastReply;
    const wrappedText = startsNewGroup ? renderTemplate(templates.firstMessageContent, { '{$MESSAGE_TEXT}': rawText }) : renderTemplate(templates.mergedMessageContent, { '{$MESSAGE_TEXT}': rawText });
    if (state.currentmessage === '') state.isContinuationBlock = !startsNewGroup;
    const reactionsHtml = processReactions(item.reactions, imagesCookie, templates.reactions, templates.reaction, animationsCookie);
    const hasEmbeds = !!(item.embeds?.length || item.embeds?.size);
    const finalReactionsHtml = hasEmbeds && reactionsHtml ? reactionsHtml.replace('class="reactions"', 'class="reactions embed-reactions"') : reactionsHtml;
    const withReactions = renderTemplate(wrappedText, { '{$MESSAGE_REACTIONS}': finalReactionsHtml });
    const isSystem = !isNormalMessage(item.type);
    const visibleText = rawText.replace(/<img\b[^>]*>/gi, 'x').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!isSystem && !isForwarded && visibleText.length === 0 && !(item.attachments?.size || item.attachments?.length) && !(item.embeds?.length || item.embeds?.size) && !(item.stickers?.size || item.stickers?.length)) continue;
    const messageHtml = isSystem && visibleText.length === 0 ? renderTemplate(getTemplate('system_message', 'channel'), { AUTHOR_NAME: escape(getDisplayName(currentMember, item.author)), TEXT: SYSTEM_MESSAGE_TEXT[item.type] ?? 'performed an action' }) : withReactions;
    state.lastauthor = item.author; state.lastmember = currentMember; state.lastdate = item.createdAt; state.messageid = item.id; state.isForwarded = isForwarded; state.forwardData = forwardData; state.lastMentioned = isMentioned; state.lastReply = isReply; state.lastReplyData = replyData; state.lastForwarded = isForwarded; state.lastInteraction = isInteraction; state.lastInteractionData = interactionData; state.currentmessage += messageHtml;
  }
  response = removeExistingEndAnchors(response); response += getTemplate('end_anchor', 'channel');
  return response;
};

exports.processChannel = async function processChannel(bot, req, res, args, discordID) {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const urlSessionID = parsedUrl.searchParams.get('sessionID') ?? '', urlTheme = parsedUrl.searchParams.get('theme'), urlImages = parsedUrl.searchParams.get('images'), urlEmoji = parsedUrl.searchParams.get('emoji');
  const { images: cookieImages, whiteThemeCookie: cookieTheme } = parseCookies(req);
  const imagesCookie = urlImages !== null ? parseInt(urlImages, 10) : (cookieImages !== undefined ? parseInt(cookieImages, 10) : 1);
  const theme = resolveTheme(req), { authorText, replyText, boxColor, barColor } = theme;
  const sessionParam = buildSessionParam(urlSessionID, urlTheme, cookieTheme, urlImages, cookieImages);
  if (!isBotReady(bot)) { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end("The bot isn't connected, try again in a moment"); return; }
  const clientTimezone = getTimezoneFromIP(req), chnl = await bot.client.channels.fetch(args[2]).catch(() => undefined);
  if (!chnl) return notFound.serve404(req, res, 'Invalid channel.', '/', 'Back to Home');
  try {
    const botMember = await chnl.guild.members.fetch(bot.client.user.id).catch(() => null);
    if (!botMember) { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('The bot is not in this server!'); return; }
    const member = await chnl.guild.members.fetch(discordID).catch(() => null);
    if (!member) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('You are not in this server! Please join the server to view this channel.'); return; }
    const canView = await require('./utils.js').canViewChannel(member, botMember, chnl);
    if (!canView) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end("You (or the bot) don't have permission to do that, or this channel type is not supported."); return; }
    const baseTemplate = renderTemplate(getTemplate('channel', ''), { COMMON_HEAD: getTemplate('head', 'partials'), PAGE_CLASS: 'page-channel', EMOJI_PICKER: getTemplate('emoji_picker', 'partials'), EMOJI_BUTTON: getTemplate('emoji_picker_button', 'partials'), CHANNEL_REPLY: '', REPLY_MESSAGE_ID_INPUT: '', WHITE_THEME_ENABLED: theme.themeClass, SERVER_ID: chnl.guild.id, CHANNEL_ID: chnl.id });
    const inputHtml = (!botMember.permissionsIn(chnl).has(PermissionFlagsBits.ManageWebhooks, true)) ? renderTemplate(getTemplate('input_disabled', 'channel'), { COLOR: boxColor, "You don't have permission to send messages in this channel.": "Discross bot doesn't have the Manage Webhooks permission" }) : (member.permissionsIn(chnl).has(PermissionFlagsBits.SendMessages, true) ? renderTemplate(getTemplate('input', 'channel'), { COLOR: boxColor }) : renderTemplate(getTemplate('input_disabled', 'channel'), { COLOR: boxColor }));
    if (!member.permissionsIn(chnl).has(PermissionFlagsBits.ReadMessageHistory, true)) {
      const final = renderTemplate(baseTemplate, { INPUT: inputHtml, MESSAGES: getTemplate('no_message_history', 'channel'), CHANNEL_NAME: (chnl.isThread() ? '' : '#') + normalizeWeirdUnicode(chnl.name), SESSION_ID: urlSessionID, SESSION_PARAM: sessionParam, EMOJI_DISPLAY: (urlEmoji === '1' ? '' : 'display: none;'), EMOJI_TOGGLE_URL: buildEmojiToggleUrl(chnl.id, urlEmoji === '1', sessionParam) });
      res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(final); return;
    }
    const messagesHtml = await exports.buildMessagesHtml({ bot, chnl, member, discordID, req, imagesCookie, animationsCookie: 1, authorText, replyText, barColor, clientTimezone, channelId: args[2] });
    const refreshUrl = chnl.id + '?random=' + Math.random() + (urlSessionID ? '&sessionID=' + encodeURIComponent(urlSessionID) : '');
    const final = renderTemplate(baseTemplate, { REFRESH_URL: refreshUrl, INPUT: inputHtml, RANDOM_EMOJI: RANDOM_EMOJIS[Math.floor(Math.random() * RANDOM_EMOJIS.length)], CHANNEL_NAME: (chnl.isThread() ? '' : '#') + normalizeWeirdUnicode(chnl.name), MESSAGES: messagesHtml, SESSION_ID: urlSessionID, SESSION_PARAM: sessionParam, EMOJI_DISPLAY: (urlEmoji === '1' ? '' : 'display: none;'), EMOJI_TOGGLE_URL: buildEmojiToggleUrl(chnl.id, urlEmoji === '1', sessionParam) });
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(final);
  } catch (err) { console.error(err); res.writeHead(500, { 'Content-Type': 'text/html' }); res.end(getTemplate('generic_error', 'misc')); }
};
