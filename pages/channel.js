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

// ---------------------------------------------------------------------------
// Template loading
// ---------------------------------------------------------------------------

function buildChannelTemplate() {
  const headPartial = getTemplate('head', 'partials');
  const emojiPicker = getTemplate('emoji_picker', 'partials');
  const emojiButton = getTemplate('emoji_picker_button', 'partials');

  return renderTemplate(getTemplate('channel', ''), {
    '{$COMMON_HEAD}': headPartial,
    '{$PAGE_CLASS}': 'page-channel',
    '{$EMOJI_PICKER}': emojiPicker,
    '{$EMOJI_BUTTON}': emojiButton,
    '{$CHANNEL_REPLY}': '',
    '{$REPLY_MESSAGE_ID_INPUT}': '',
  });
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

  // Unicode emoji — single-pass replacement
  messagetext = messagetext.replace(emojiRegex, (match) => {
    const code = unicodeToTwemojiCode(match);
    return renderTemplate(tmpl_twemoji, {
      CODE: code,
      PX: px.toString(),
      STYLE: imgStyle,
    });
  });

  // Custom emoji
  [...messagetext.matchAll(/&lt;(:)?(?:(a):)?(\w{2,32}):(\d{16,20})?(?:(?!\1).)*&gt;/g)].forEach(
    (match) => {
      const animated = !!match[2];
      const ext = animated && animationsCookie === 1 ? 'gif' : 'png';
      cacheCustomEmoji(match[4], match[3], animated);
      messagetext = messagetext.replace(
        match[0],
        renderTemplate(tmpl_custom, {
          EMOJI_ID: match[4],
          EXT: ext,
          PX: px.toString(),
          STYLE: imgStyle,
        })
      );
    }
  );

  return messagetext;
}

// ---------------------------------------------------------------------------
// Attachment rendering
// ---------------------------------------------------------------------------

function renderAttachments(messagetext, item, imagesCookie, tmpl_file_download) {
  if (!item?.attachments?.size) return messagetext;

  const tmpl_spoiler = getTemplate('spoiler_image', 'channel');
  const tmpl_normal_image = getTemplate('normal_image', 'channel');

  const IMAGE_EXT = /\.(jpg|gif|png|jpeg|avif|svg|webp|tif|tiff)$/i;
  const VIDEO_EXT = /\.(mp4|webm|mov|avi|mkv)$/i;
  const imageData = []; // Store {url, isSpoiler} for each image

  item.attachments.forEach((attachment) => {
    const isImage = IMAGE_EXT.test(attachment.name);
    const isVideo = VIDEO_EXT.test(attachment.name);
    const isSpoiler = attachment.name.toUpperCase().startsWith('SPOILER_');
    const proxyBase = isImage && imagesCookie === 1 ? '/imageProxy/' : '/fileProxy/';
    const url = proxyBase + attachment.url.replace(/^(.*?)(\d+)/, '$2');

    if (isImage && imagesCookie === 1) {
      imageData.push({ url, isSpoiler });
    } else {
      // File download card
      const card = renderTemplate(tmpl_file_download, {
        '{$FILE_NAME}': truncateFileName(attachment.name),
        '{$FILE_SIZE}': formatFileSize(attachment.size),
        '{$FILE_LINK}': !isVideo || imagesCookie !== 1 ? url : '{$FILE_LINK}',
      });
      messagetext += card;
    }
  });

  imageData.forEach(({ url, isSpoiler }) => {
    if (isSpoiler) {
      messagetext += renderTemplate(tmpl_spoiler, { IMAGE_URL: url });
    } else {
      messagetext += renderTemplate(tmpl_normal_image, { IMAGE_URL: url });
    }
  });

  return messagetext;
}

// ---------------------------------------------------------------------------
// Sticker rendering
// ---------------------------------------------------------------------------

function renderStickers(messagetext, item, imagesCookie) {
  if (!item.stickers?.size) return messagetext;

  const tmpl_sticker = getTemplate('sticker', 'channel');
  const tmpl_sticker_text = getTemplate('sticker_text', 'channel');

  item.stickers.forEach((sticker) => {
    const sep = messagetext ? '<br>' : '';
    if (imagesCookie === 1) {
      messagetext += sep + renderTemplate(tmpl_sticker, { STICKER_ID: sticker.id });
    } else {
      messagetext +=
        sep +
        renderTemplate(tmpl_sticker_text, { STICKER_NAME: escape(sticker.name ?? 'Unknown') });
    }
  });

  return messagetext;
}

// ---------------------------------------------------------------------------
// Embed rendering (inline media types handled here; rich embeds delegated)
// ---------------------------------------------------------------------------

function buildProxiedImageTag(
  rawUrl,
  alt,
  style = 'max-width:256px;max-height:200px;height:auto;'
) {
  const proxied = `/imageProxy/external/${Buffer.from(rawUrl).toString('base64')}`;
  const tag = renderTemplate(getTemplate('image_tag', 'channel'), {
    PROXIED_URL: proxied,
    STYLE: style,
    ALT: alt,
  });
  return { proxied, tag };
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

  item.embeds.forEach((embed) => {
    const isTenor =
      (embed.provider?.name === 'Tenor' || urlMatchesDomain(embed.url, 'tenor.com')) &&
      embed.thumbnail?.url;
    const isGiphy =
      (embed.provider?.name === 'GIPHY' || urlMatchesDomain(embed.url, 'giphy.com')) &&
      (embed.thumbnail?.url || embed.image?.url);
    const isYouTube =
      (embed.provider?.name === 'YouTube' ||
        urlMatchesDomain(embed.url, 'youtube.com') ||
        urlMatchesDomain(embed.url, 'youtu.be')) &&
      embed.thumbnail?.url;

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
  (embed.fields ?? []).forEach((f) => {
    fieldMap[f.name] = f.value;
  });

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
// Mention resolution
// ---------------------------------------------------------------------------

function roleMentionPill(role, tmpl_mention) {
  const name = escape('@' + normalizeWeirdUnicode(role.name));
  if (role.color !== 0) {
    const hex = role.hexColor;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return renderTemplate(getTemplate('role_mention_colored', 'channel'), {
      HEX: hex,
      R: r.toString(),
      G: g.toString(),
      B: b.toString(),
      NAME: name,
    });
  }
  return renderTemplate(getTemplate('role_mention_plain', 'channel'), { NAME: name });
}

function renderKnownMentions(messagetext, item, tmpl_mention) {
  if (!item.mentions?.members) return messagetext;

  item.mentions.members.forEach((user) => {
    if (!user) return;
    const pill = renderTemplate(tmpl_mention, {
      '{$USERNAME}': escape('@' + normalizeWeirdUnicode(user.displayName)),
    });
    messagetext = renderTemplate(messagetext, {
      [`&lt;@${user.id}&gt;`]: pill,
      [`&lt;@!${user.id}&gt;`]: pill,
    });
  });

  item.mentions.roles?.forEach((role) => {
    if (!role) return;
    messagetext = renderTemplate(messagetext, {
      [`&lt;@&amp;${role.id}&gt;`]: roleMentionPill(role, tmpl_mention),
    });
  });

  return messagetext;
}

async function resolveRemainingMentions(messagetext, chnl, memberCache, tmpl_mention) {
  // Fetch any member IDs not yet in cache
  const unresolvedIds = [...messagetext.matchAll(/&lt;@!?(\d{16,20})&gt;/g)]
    .map((m) => m[1])
    .filter((id) => !memberCache.has(id));

  await Promise.allSettled(
    unresolvedIds.map(async (id) => {
      try {
        memberCache.set(id, await chnl.guild.members.fetch(id));
      } catch {
        memberCache.set(id, null);
      }
    })
  );

  return messagetext.replace(/&lt;@!?(\d{16,20})&gt;/g, (match, userId) => {
    const resolved = memberCache.get(userId) ?? chnl.guild.members.cache.get(userId);
    if (resolved) {
      return renderTemplate(tmpl_mention, {
        '{$USERNAME}': escape('@' + normalizeWeirdUnicode(getDisplayName(resolved, resolved.user))),
      });
    }
    return renderTemplate(tmpl_mention, { '{$USERNAME}': '@unknown-user' });
  });
}

async function resolveChannelMentions(messagetext, bot, chnl) {
  const unresolvedIds = [...messagetext.matchAll(/&lt;#(\d{16,20})&gt;/g)]
    .map((m) => m[1])
    .filter((id) => !bot.client.channels.cache.has(id));

  await Promise.allSettled(
    unresolvedIds.map(async (id) => {
      try {
        await bot.client.channels.fetch(id);
      } catch {
        /* not accessible */
      }
    })
  );

  return messagetext.replace(/&lt;#(\d{16,20})&gt;/g, (match, id) => {
    const { ChannelType } = require('discord.js');
    const ch = bot.client.channels.cache.get(id);
    if (!ch) return match;

    // Prevent linking Forum/Media channels in mentions
    if (ch.type === ChannelType.GuildForum || ch.type === ChannelType.GuildMedia) {
      return '#' + escape(normalizeWeirdUnicode(ch.name));
    }

    return renderTemplate(getTemplate('channel_mention', 'channel'), {
      CHANNEL_URL: `/channels/${ch.id}`,
      CHANNEL_NAME: escape(normalizeWeirdUnicode(ch.name)),
    });
  });
}

function renderEveryoneMentions(messagetext, item, tmpl_mention) {
  if (!item.mentions?.everyone) return messagetext;

  const data = {};
  if (messagetext.includes('@everyone')) {
    data['@everyone'] = renderTemplate(tmpl_mention, { '{$USERNAME}': '@everyone' });
  }
  if (messagetext.includes('@here')) {
    data['@here'] = renderTemplate(tmpl_mention, { '{$USERNAME}': '@here' });
  }

  return renderTemplate(messagetext, data);
}

// ---------------------------------------------------------------------------
// isMentioned detection
// ---------------------------------------------------------------------------

function detectMention(item, member, discordID, isReply, replyData) {
  if (item.mentions?.members?.has(discordID)) {
    // If it's a self-reply, only highlight if the mention is in the message content
    if (isReply && item.author?.id === discordID && replyData?.authorId === discordID) {
      const mentionRegex = new RegExp(`<@!?${discordID}>`);
      if (!mentionRegex.test(item.content)) return false;
    }
    return true;
  }
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

async function resolveForwardData(
  item,
  chnl,
  bot,
  discordID,
  memberCache,
  clientTimezone,
  req,
  imagesCookie,
  animationsCookie,
  barColor
) {
  try {
    const fwdMsg = await item.fetchReference();
    const fwdMember = fwdMsg.author?.bot
      ? null
      : await ensureMemberData(fwdMsg, chnl.guild, memberCache);

    const content = truncateText(fwdMsg.content, FORWARDED_CONTENT_MAX_LENGTH);

    const originHtml = await (async () => {
      const snowflakeRe = /^\d{16,20}$/;
      if (!fwdMsg.guildId || !snowflakeRe.test(fwdMsg.channelId) || !snowflakeRe.test(fwdMsg.id))
        return '';
      const fwdChannel = fwdMsg.channel ?? bot.client.channels.cache.get(fwdMsg.channelId);
      if (!fwdChannel) return '';
      const timeDisplay = formatForwardedTimestamp(fwdMsg.createdAt, clientTimezone);
      const jumpLink = `/channels/${fwdMsg.channelId}/${fwdMsg.id}`;
      const chanLink = renderTemplate(getTemplate('forwarded_same_server', 'channel'), {
        JUMP_LINK: jumpLink,
        CHANNEL_NAME: escape(normalizeWeirdUnicode(fwdChannel.name)),
        TIME_DISPLAY: timeDisplay,
      });
      if (fwdMsg.guildId === chnl.guild.id) {
        return renderTemplate(getTemplate('forwarded_content_block_label', 'channel'), {
          CONTENT: chanLink,
        });
      }
      const otherGuild = bot.client.guilds.cache.get(fwdMsg.guildId);
      if (!otherGuild) return '';
      await otherGuild.members.fetch(discordID);
      return renderTemplate(getTemplate('forwarded_other_server', 'channel'), {
        GUILD_NAME: escape(normalizeWeirdUnicode(otherGuild.name)),
        CONTENT: chanLink,
      });
    })().catch(() => '');

    // Prefer snapshot embeds when fwdMsg.embeds is empty (snapshot is always present
    // and doesn't require an extra API call for the embed data).
    const snapshotMsg = item.messageSnapshots?.first();
    const embedsSource = fwdMsg.embeds?.length ? fwdMsg : (snapshotMsg ?? fwdMsg);
    const embedsHtml = renderEmbeds(
      '',
      embedsSource,
      req,
      imagesCookie,
      animationsCookie,
      clientTimezone
    );

    return {
      author: getDisplayName(fwdMember, fwdMsg.author),
      content: renderDiscordMarkdown(content, { barColor }),
      date: formatDateWithTimezone(fwdMsg.createdAt, clientTimezone),
      origin: originHtml,
      embeds: embedsHtml,
    };
  } catch {
    // fetchReference() failed (e.g. message deleted, channel inaccessible).
    // Fall back to the message snapshot so we can still display the forwarded content.
    const snapshotMsg = item.messageSnapshots?.first();
    if (!snapshotMsg) return null;

    const content = truncateText(snapshotMsg.content ?? '', FORWARDED_CONTENT_MAX_LENGTH);
    const embedsHtml = renderEmbeds(
      '',
      snapshotMsg,
      req,
      imagesCookie,
      animationsCookie,
      clientTimezone
    );

    return {
      author: getDisplayName(null, snapshotMsg.author) || '',
      content: renderDiscordMarkdown(content, { barColor }),
      date: snapshotMsg.createdAt
        ? formatDateWithTimezone(snapshotMsg.createdAt, clientTimezone)
        : '',
      origin: '',
      embeds: embedsHtml,
    };
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
  msg.mentions?.members?.forEach((member) => {
    if (!member) return;
    const name = '@' + normalizeWeirdUnicode(getDisplayName(member, member.user));
    text = text.split(`<@${member.id}>`).join(name);
    text = text.split(`<@!${member.id}>`).join(name);
  });
  msg.mentions?.roles?.forEach((role) => {
    if (!role) return;
    text = text.split(`<@&${role.id}>`).join('@' + normalizeWeirdUnicode(role.name));
  });
  // Fetch any remaining unrecognized user IDs from the API
  const unresolvedUserIds = [...text.matchAll(/<@!?(\d{16,20})>/g)]
    .map((m) => m[1])
    .filter((id) => !memberCache.has(id));
  await Promise.allSettled(
    unresolvedUserIds.map(async (id) => {
      try {
        memberCache.set(id, await chnl.guild.members.fetch(id));
      } catch {
        memberCache.set(id, null);
      }
    })
  );
  text = text.replace(/<@!?(\d{16,20})>/g, (match, id) => {
    const cached = memberCache.get(id) ?? chnl.guild.members.cache.get(id);
    if (cached) return '@' + normalizeWeirdUnicode(getDisplayName(cached, cached.user));
    return match;
  });
  // Fetch any unresolved channel IDs from the API
  const unresolvedChannelIds = [...text.matchAll(/<#(\d{16,20})>/g)]
    .map((m) => m[1])
    .filter((id) => !bot.client.channels.cache.has(id));
  await Promise.allSettled(
    unresolvedChannelIds.map(async (id) => {
      try {
        await bot.client.channels.fetch(id);
      } catch {
        /* not accessible */
      }
    })
  );
  text = text.replace(/<#(\d{16,20})>/g, (match, id) => {
    const ch = bot.client.channels.cache.get(id);
    if (ch) return '#' + normalizeWeirdUnicode(ch.name);
    return match;
  });
  return text;
}

async function resolveReplyData(
  item,
  chnl,
  memberCache,
  bot,
  imagesCookie,
  animationsCookie,
  barColor,
  authorText
) {
  try {
    const replyMessage = await item.fetchReference().catch(() => null);
    const replyUser = replyMessage?.author ?? item.mentions?.repliedUser;

    const replyMember = await (async () => {
      if (replyMessage) {
        return replyMessage.author?.bot
          ? null
          : await ensureMemberData(replyMessage, chnl.guild, memberCache);
      }
      if (!replyUser?.id) return undefined;
      if (memberCache.has(replyUser.id)) return memberCache.get(replyUser.id);
      return chnl.guild.members
        .fetch(replyUser.id)
        .then((m) => {
          memberCache.set(replyUser.id, m);
          return m;
        })
        .catch(() => undefined /* left the server */);
    })();

    const replyContent = replyMessage?.content
      ? await (async () => {
          const trimmedFlat = replyMessage.content
            .replace(/\r?\n/g, ' ')
            .replace(/  +/g, ' ')
            .trim();
          // Resolve mentions/channels in raw text before truncation so they are never cut in half
          const resolvedFlat = await resolveRawMentionsForPreview(
            trimmedFlat,
            replyMessage,
            memberCache,
            chnl,
            bot
          );
          // Strip block-level quote markers (>>> and >) so they don't render as
          // full blockquote embeds inside the reply preview — show them as plain > text
          const cleanFlat = resolvedFlat.replace(/^(>>?>?\s*)+/, '');
          return truncateText(cleanFlat, REPLY_CONTENT_MAX_LENGTH);
        })()
      : '';

    return {
      author: getDisplayName(replyMember, replyUser),
      authorId: replyUser?.id,
      authorColor: getMemberColor(replyMember, authorText),
      mentionsPing:
        item.mentions?.repliedUser !== null &&
        item.mentions?.repliedUser !== undefined &&
        item.author?.id !== replyUser?.id,
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

function buildReplyIndicator(replyData, replyText, barColor = '#808080') {
  const ellipsis = '...';
  const ellipsisLength = ellipsis.length;
  const lineBreakTagPattern = /<br[^>]*>/gi;
  // 42 chars fits the 200px preview width with 11px Rodin/fallback text in manual Chromium/Linux checks.
  const maxReplyPreviewLength = 42;
  const contentLengthBeforeTruncation = maxReplyPreviewLength - ellipsisLength;
  const replyTextTopOffset = -1;
  const atSign = replyData.mentionsPing ? '@' : '';
  const normalizedReplyContent = (replyData.content || '')
    .replace(lineBreakTagPattern, ' ')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const replyContentChars = Array.from(normalizedReplyContent);
  const truncatedReplyPreview =
    replyContentChars.length > maxReplyPreviewLength
      ? `${replyContentChars.slice(0, contentLengthBeforeTruncation).join('')}${ellipsis}`
      : normalizedReplyContent;
  const safeReplyPreview = he.encode(truncatedReplyPreview, { useNamedReferences: true });
  // Single-row layout: the left indicator cell uses border-left + border-top +
  // border-top-left-radius to draw a reliable ┌ corner shape.
  // The author and content cells sit to the right in the same row.
  // Keep reply content on one line and use a plain "..." suffix when truncated.
  const contentTd = truncatedReplyPreview
    ? renderTemplate(getTemplate('reply_content_cell', 'channel'), {
        REPLY_TEXT_TOP_OFFSET: replyTextTopOffset.toString(),
        REPLY_TEXT: replyText,
        REPLY_PREVIEW: safeReplyPreview,
      })
    : '';

  const row = renderTemplate(getTemplate('reply_with_content', 'channel'), {
    BAR_COLOR: barColor,
    REPLY_TEXT_TOP_OFFSET: replyTextTopOffset.toString(),
    AUTHOR_COLOR: replyData.authorColor,
    AT_SIGN: atSign,
    AUTHOR_NAME: escape(replyData.author),
    CONTENT_TD: contentTd,
  });

  return (
    '<table cellpadding="0" cellspacing="0" style="margin-bottom:4px;line-height:1">' +
    row +
    '</table>'
  );
}

// ---------------------------------------------------------------------------
// Interaction (slash command) data resolution
// ---------------------------------------------------------------------------

async function resolveInteractionData(item, chnl, memberCache, authorText) {
  try {
    const interactionUser = item.interaction?.user;
    if (!interactionUser) return null;

    const cached = memberCache.get(interactionUser.id);
    const interactionMember =
      cached !== undefined
        ? cached
        : await chnl.guild.members
            .fetch(interactionUser.id)
            .then((m) => {
              memberCache.set(interactionUser.id, m);
              return m;
            })
            .catch(() => undefined);

    return {
      author: getDisplayName(interactionMember, interactionUser),
      authorColor: getMemberColor(interactionMember, authorText),
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

function buildInteractionIndicator(interactionData, textColor, barColor = '#808080') {
  const tableStart = '<table cellpadding="0" cellspacing="0" style="margin-bottom:4px"><tr>';
  const tableEnd = '</tr></table>';
  const row = renderTemplate(getTemplate('interaction_indicator', 'channel'), {
    BAR_COLOR: barColor,
    AUTHOR_COLOR: interactionData.authorColor,
    AUTHOR_NAME: escape(interactionData.author),
    TEXT_COLOR: textColor,
    COMMAND_NAME: escape(interactionData.commandName),
  });
  return tableStart + row + tableEnd;
}

// ---------------------------------------------------------------------------
// Message group flushing
// ---------------------------------------------------------------------------

function flushMessageGroup(state, templates, authorText, replyText, barColor, channelId) {
  const {
    currentmessage,
    isForwarded,
    forwardData,
    lastMentioned,
    lastReply,
    lastReplyData,
    lastInteraction,
    lastInteractionData,
    lastauthor,
    lastmember,
    lastdate,
    messageid,
    isContinuationBlock,
  } = state;

  const replyLink = channelId ? `/channels/${channelId}/${messageid}` : 'javascript:void(0)';

  // Wrap in appropriate outer template
  const baseHtml = (() => {
    if (isContinuationBlock && !isForwarded && !lastMentioned)
      return renderTemplate(templates.messageContinuation, {
        '{$MESSAGE_CONTENT}': currentmessage,
      });
    if (isForwarded && lastMentioned)
      return renderTemplate(templates.messageForwardedMentioned, {
        '{$MESSAGE_CONTENT}': currentmessage,
      });
    if (isForwarded)
      return renderTemplate(templates.messageForwarded, { '{$MESSAGE_CONTENT}': currentmessage });
    if (lastMentioned)
      return renderTemplate(templates.messageMentioned, {
        '{$MESSAGE_CONTENT}': currentmessage,
        '{$MESSAGE_REPLY_LINK}': replyLink,
      });
    return renderTemplate(templates.message, {
      '{$MESSAGE_CONTENT}': currentmessage,
      '{$MESSAGE_REPLY_LINK}': replyLink,
    });
  })();

  // Forwarded metadata
  const contentBlock =
    isForwarded && forwardData.content
      ? renderTemplate(getTemplate('forwarded_content_block', 'channel'), {
          CONTENT: forwardData.content,
        })
      : '';
  const afterForwarded = isForwarded
    ? renderTemplate(baseHtml, {
        '{$FORWARDED_AUTHOR}': escape(forwardData.author),
        '{$FORWARDED_CONTENT_BLOCK}': contentBlock,
        '{$FORWARDED_DATE}': forwardData.date,
        '{$FORWARDED_EMBEDS}': forwardData.embeds ?? '',
        '{$FORWARDED_ORIGIN}': forwardData.origin ?? '',
      })
    : baseHtml;

  const displayName = getDisplayName(lastmember, lastauthor);
  const authorColor = getMemberColor(lastmember, authorText);
  const replyIndicator = lastReply
    ? buildReplyIndicator(lastReplyData, replyText, barColor)
    : lastInteraction
      ? buildInteractionIndicator(lastInteractionData, replyText, barColor)
      : '';

  return renderTemplate(afterForwarded, {
    '{$MESSAGE_AUTHOR}': escape(displayName),
    '{$AUTHOR_COLOR}': authorColor,
    '{$REPLY_INDICATOR}': replyIndicator,
    '{$PING_INDICATOR}': '',
    '{$MESSAGE_DATE}': formatDateWithTimezone(lastdate, state.clientTimezone),
    '{$TAG}': he.encode(JSON.stringify(`<@${lastauthor.id}>`)),
  });
}

// ---------------------------------------------------------------------------
// Core message rendering
// ---------------------------------------------------------------------------

async function renderMessageContent(item, context) {
  const {
    bot,
    chnl,
    member,
    discordID,
    req,
    imagesCookie,
    animationsCookie,
    clientTimezone,
    memberCache,
    templates,
    barColor,
  } = context;

  const withMarkdown = renderDiscordMarkdown(item.content || '', {
    barColor,
    timezone: clientTimezone,
  });
  const withDiscordTimestamps = replaceDiscordTimestamps(withMarkdown, clientTimezone);
  const withEmojis = renderEmojis(withDiscordTimestamps, item, imagesCookie, animationsCookie);
  const withAttachments = renderAttachments(withEmojis, item, imagesCookie, templates.fileDownload);
  const withStickers = renderStickers(withAttachments, item, imagesCookie);
  const withEmbeds = renderEmbeds(
    withStickers,
    item,
    req,
    imagesCookie,
    animationsCookie,
    clientTimezone
  );
  const withPoll = item?.poll ? withEmbeds + processPoll(item.poll, imagesCookie) : withEmbeds;
  const withKnownMentions = renderKnownMentions(withPoll, item, templates.mention);
  const withRemainingMentions = await resolveRemainingMentions(
    withKnownMentions,
    chnl,
    memberCache,
    templates.mention
  );
  const withChannelMentions = await resolveChannelMentions(withRemainingMentions, bot, chnl);
  const withEveryoneMentions = renderEveryoneMentions(withChannelMentions, item, templates.mention);

  // Role mentions (second pass — catches any remaining after the member pass)
  const withRoleMentions = (item.mentions?.roles || []).reduce((text, role) => {
    if (!role) return text;
    return text.replaceAll(`&lt;@&amp;${role.id}&gt;`, roleMentionPill(role, templates.mention));
  }, withEveryoneMentions);

  return withRoleMentions;
}

// ---------------------------------------------------------------------------
// buildMessagesHtml — public API
// ---------------------------------------------------------------------------

exports.buildMessagesHtml = async function buildMessagesHtml(params) {
  const {
    bot,
    chnl,
    member,
    discordID,
    req,
    imagesCookie,
    animationsCookie = 1,
    authorText,
    replyText,
    barColor = '#808080',
    clientTimezone,
    channelId,
    messages: overrideMessages,
  } = params;

  // Unify template references under camelCase — now loaded via getTemplate
  const templates = {
    message: getTemplate('message', 'message'),
    messageForwarded: getTemplate('forwarded_message', 'message'),
    messageMentioned: getTemplate('message_mentioned', 'message'),
    messageForwardedMentioned: getTemplate('forwarded_message_mentioned', 'message'),
    firstMessageContent: getTemplate('first_message_content', 'message'),
    mergedMessageContent: getTemplate('merged_message_content', 'message'),
    mention: getTemplate('mention', 'message'),
    fileDownload: getTemplate('file_download', 'channel'),
    reactions: getTemplate('reactions', 'message'),
    reaction: getTemplate('reaction', 'message'),
    dateSeparator: getTemplate('date_separator', 'message'),
    messageContinuation: getTemplate('message_continuation', 'message'),
  };

  const messages = overrideMessages ?? (await bot.getHistoryCached(chnl));
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
    lastForwarded: false,
    lastInteraction: false,
    lastInteractionData: {},
    isContinuationBlock: false,
    clientTimezone,
  };

  let response = '';

  const context = {
    bot,
    chnl,
    member,
    discordID,
    req,
    imagesCookie,
    animationsCookie,
    clientTimezone,
    memberCache,
    templates,
    barColor,
  };

  const shouldStartNewGroup = (item) =>
    !state.lastauthor ||
    !isSameAuthor(state.lastmember, state.lastauthor, null, item.author) ||
    item.createdAt - state.lastdate > MESSAGE_GROUP_TIMEOUT_MS ||
    !!item.reference ||
    state.lastReply ||
    state.lastInteraction ||
    state.lastForwarded;

  const processItem = async (item) => {
    // Flush the previous group when the author changes or this is the sentinel call
    if (state.lastauthor) {
      const flushNow = !item || shouldStartNewGroup(item);
      if (flushNow) {
        response += flushMessageGroup(state, templates, authorText, replyText, barColor, channelId);
        state.currentmessage = '';
      }
    }

    if (!item) return;

    const currentMember = await ensureMemberData(item, chnl.guild, memberCache);

    // Date separator
    if (clientTimezone && areDifferentDays(item.createdAt, state.lastmessagedate, clientTimezone)) {
      const sep = renderTemplate(templates.dateSeparator, {
        '{$DATE_SEPARATOR}': formatDateSeparator(item.createdAt, clientTimezone),
      });
      response += sep;
    }
    state.lastmessagedate = item.createdAt;

    // Resolve forward / reply metadata
    const fwdData =
      item.reference?.type === MessageReferenceType.Forward
        ? await resolveForwardData(
            item,
            chnl,
            bot,
            discordID,
            memberCache,
            clientTimezone,
            req,
            imagesCookie,
            animationsCookie,
            barColor
          )
        : null;
    const isForwarded = fwdData !== null;
    const forwardData = fwdData ?? {};

    const rplyData =
      item.reference && !isForwarded
        ? await resolveReplyData(
            item,
            chnl,
            memberCache,
            bot,
            imagesCookie,
            animationsCookie,
            barColor,
            authorText
          )
        : null;
    const isReply = rplyData !== null;
    const replyData = rplyData ?? {};

    const intData = item.interaction
      ? await resolveInteractionData(item, chnl, memberCache, authorText)
      : null;
    const isInteraction = intData !== null;
    const interactionData = intData ?? {};

    const rawText = await renderMessageContent(item, context);

    const isMentioned = detectMention(item, member, discordID, isReply, replyData);

    // Wrap in first-message or merged template
    const startsNewGroup =
      !state.lastauthor ||
      !isSameAuthor(state.lastmember, state.lastauthor, currentMember, item.author) ||
      item.createdAt - state.lastdate > MESSAGE_GROUP_TIMEOUT_MS ||
      isReply ||
      isInteraction ||
      state.lastReply;

    const wrappedText = startsNewGroup
      ? renderTemplate(templates.firstMessageContent, { '{$MESSAGE_TEXT}': rawText })
      : renderTemplate(templates.mergedMessageContent, { '{$MESSAGE_TEXT}': rawText });

    // Track whether this is the first message of a continuation block (same author,
    // recent, no reply) — used by flushMessageGroup to omit the author header.
    if (state.currentmessage === '') {
      state.isContinuationBlock = !startsNewGroup;
    }

    const reactionsHtml = processReactions(
      item.reactions,
      imagesCookie,
      templates.reactions,
      templates.reaction,
      animationsCookie
    );
    const hasEmbeds = item.embeds && item.embeds.length > 0;
    const finalReactionsHtml =
      hasEmbeds && reactionsHtml
        ? reactionsHtml.replace('class="reactions"', 'class="reactions embed-reactions"')
        : reactionsHtml;
    const withReactions = renderTemplate(wrappedText, {
      '{$MESSAGE_REACTIONS}': finalReactionsHtml,
    });

    // System message handling
    const isSystem = !isNormalMessage(item.type);
    const visibleText = rawText
      .replace(/<img\b[^>]*>/gi, 'x')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (
      !isSystem &&
      !isForwarded &&
      visibleText.length === 0 &&
      !item.attachments?.size &&
      !item.embeds?.length &&
      !item.stickers?.size
    ) {
      return; // nothing to show
    }

    const messagetext =
      isSystem && visibleText.length === 0
        ? renderTemplate(getTemplate('system_message', 'channel'), {
            COLOR: authorText,
            TEXT: SYSTEM_MESSAGE_TEXT[item.type] ?? 'performed an action',
          })
        : withReactions;

    // Advance state
    state.lastauthor = item.author;
    state.lastmember = currentMember;
    state.lastdate = item.createdAt;
    state.messageid = item.id;
    state.isForwarded = isForwarded;
    state.forwardData = forwardData;
    state.lastMentioned = isMentioned;
    state.lastReply = isReply;
    state.lastReplyData = replyData;
    state.lastForwarded = isForwarded;
    state.lastInteraction = isInteraction;
    state.lastInteractionData = interactionData;
    state.currentmessage += messagetext;
  };

  for (const item of messages) {
    await processItem(item);
  }
  await processItem(null); // flush final group

  response = removeExistingEndAnchors(response);
  response += getTemplate('end_anchor', 'channel');
  return response;
};

// ---------------------------------------------------------------------------
// Preferences helper
// ---------------------------------------------------------------------------

function resolvePreferences(req) {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const urlSessionID = parsedUrl.searchParams.get('sessionID') ?? '';
  const urlTheme = parsedUrl.searchParams.get('theme');
  const urlImages = parsedUrl.searchParams.get('images');
  const urlEmoji = parsedUrl.searchParams.get('emoji');

  const { images: cookieImages, whiteThemeCookie: cookieTheme } = parseCookies(req);

  const imagesCookie =
    urlImages !== null
      ? parseInt(urlImages, 10)
      : cookieImages !== undefined
        ? parseInt(cookieImages, 10)
        : 1;

  const sessionParam = buildSessionParam(
    urlSessionID,
    urlTheme,
    cookieTheme,
    urlImages,
    cookieImages
  );

  return { urlSessionID, imagesCookie, sessionParam, emojiOpen: urlEmoji === '1' };
}

// ---------------------------------------------------------------------------
// Input template selection
// ---------------------------------------------------------------------------

function buildInputHtml(botMember, member, chnl, boxColor) {
  const canWebhook = botMember.permissionsIn(chnl).has(PermissionFlagsBits.ManageWebhooks, true);
  const canSend = member.permissionsIn(chnl).has(PermissionFlagsBits.SendMessages, true);

  if (!canWebhook) {
    return renderTemplate(getTemplate('input_disabled', 'channel'), {
      '{$COLOR}': boxColor,
      "You don't have permission to send messages in this channel.":
        "Discross bot doesn't have the Manage Webhooks permission",
    });
  }
  if (canSend) {
    return renderTemplate(getTemplate('input', 'channel'), { '{$COLOR}': boxColor });
  }
  return renderTemplate(getTemplate('input_disabled', 'channel'), { '{$COLOR}': boxColor });
}

// ---------------------------------------------------------------------------
// processChannel — public API
// ---------------------------------------------------------------------------

exports.processChannel = async function processChannel(bot, req, res, args, discordID) {
  const { urlSessionID, imagesCookie, sessionParam, emojiOpen } = resolvePreferences(req);
  const theme = resolveTheme(req);

  const { authorText, replyText, boxColor, barColor } = theme;

  if (!isBotReady(bot)) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end("The bot isn't connected, try again in a moment");
    return;
  }

  const clientTimezone = getTimezoneFromIP(req);

  const chnl = await bot.client.channels.fetch(args[2]).catch(() => undefined);

  if (!chnl) {
    return notFound.serve404(req, res, 'Invalid channel.', '/', 'Back to Home');
  }

  try {
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

    const canView = await require('./utils.js').canViewChannel(member, botMember, chnl);

    if (!canView) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end(
        "You (or the bot) don't have permission to do that, or this channel type is not supported."
      );
      return;
    }

    const baseTemplate = renderTemplate(buildChannelTemplate(), {
      '{$WHITE_THEME_ENABLED}': theme.themeClass,
      '{$SERVER_ID}': chnl.guild.id,
      '{$CHANNEL_ID}': chnl.id,
    });
    const inputHtml = buildInputHtml(botMember, member, chnl, boxColor);

    const emojiDisplay = emojiOpen ? '' : 'display: none;';
    const emojiToggleUrl = buildEmojiToggleUrl(chnl.id, emojiOpen, sessionParam);

    // No message history permission
    if (!member.permissionsIn(chnl).has(PermissionFlagsBits.ReadMessageHistory, true)) {
      const final = renderTemplate(baseTemplate, {
        '{$INPUT}': inputHtml,
        '{$MESSAGES}': getTemplate('no_message_history', 'channel'),
        '{$CHANNEL_NAME}': (chnl.isThread() ? '' : '#') + normalizeWeirdUnicode(chnl.name),
        '{$SESSION_ID}': urlSessionID,
        '{$SESSION_PARAM}': sessionParam,
        '{$EMOJI_DISPLAY}': emojiOpen ? '' : 'display: none;',
        '{$EMOJI_TOGGLE_URL}': buildEmojiToggleUrl(chnl.id, emojiOpen, sessionParam),
      });
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(final);
      return;
    }

    const messagesHtml = await exports.buildMessagesHtml({
      bot,
      chnl,
      member,
      discordID,
      req,
      imagesCookie,
      animationsCookie: 1,
      authorText,
      replyText,
      barColor,
      clientTimezone,
      channelId: args[2],
    });

    const refreshUrl =
      chnl.id +
      '?random=' +
      Math.random() +
      (urlSessionID ? '&sessionID=' + encodeURIComponent(urlSessionID) : '');

    const final = renderTemplate(baseTemplate, {
      '{$REFRESH_URL}': refreshUrl,
      '{$INPUT}': inputHtml,
      '{$RANDOM_EMOJI}': RANDOM_EMOJIS[Math.floor(Math.random() * RANDOM_EMOJIS.length)],
      '{$CHANNEL_NAME}': (chnl.isThread() ? '' : '#') + normalizeWeirdUnicode(chnl.name),
      '{$MESSAGES}': messagesHtml,
      '{$SESSION_ID}': urlSessionID,
      '{$SESSION_PARAM}': sessionParam,
      '{$EMOJI_DISPLAY}': emojiOpen ? '' : 'display: none;',
      '{$EMOJI_TOGGLE_URL}': buildEmojiToggleUrl(chnl.id, emojiOpen, sessionParam),
    });

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(final);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(getTemplate('generic_error', 'misc'));
  }
};
