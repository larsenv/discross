var fs = require('fs');
var escape = require('escape-html');
var auth = require('../authentication.js');
const { ChannelType } = require('discord.js');
const emojiRegex = require("./twemojiRegex").regex;
const { renderDiscordMarkdown } = require('./discordMarkdown');
const { getDisplayName } = require('./memberUtils');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const { getClientIP, getTimezoneFromIP, formatDateWithTimezone, formatDateSeparator, areDifferentDays } = require('../timezoneUtils');
const { processEmbeds } = require('./embedUtils');
const { processReactions } = require('./reactionUtils');

// Templates
const server_template = fs.readFileSync('pages/templates/server.html', 'utf-8').split('{$COMMON_HEAD}').join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));
const dm_channel_template = fs.readFileSync('pages/templates/dm_channel.html', 'utf-8').split('{$COMMON_HEAD}').join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));

const server_icon_template = fs.readFileSync('pages/templates/server/server_icon.html', 'utf-8');
const no_images_warning_template = fs.readFileSync('pages/templates/server/no_images_warning.html', 'utf-8');
const images_enabled_template = fs.readFileSync('pages/templates/server/images_enabled.html', 'utf-8');

const message_template = fs.readFileSync('pages/templates/message/message.html', 'utf-8');
const first_message_content_template = fs.readFileSync('pages/templates/message/first_message_content.html', 'utf-8');
const merged_message_content_template = fs.readFileSync('pages/templates/message/merged_message_content.html', 'utf-8');
const reactions_template = fs.readFileSync('pages/templates/message/reactions.html', 'utf-8');
const reaction_template = fs.readFileSync('pages/templates/message/reaction.html', 'utf-8');
const date_separator_template = fs.readFileSync('pages/templates/message/date_separator.html', 'utf-8');
const file_download_template = fs.readFileSync('pages/templates/channel/file_download.html', 'utf-8');
const input_template = fs.readFileSync('pages/templates/channel/input.html', 'utf-8');
const input_disabled_template = fs.readFileSync('pages/templates/channel/input_disabled.html', 'utf-8');
const no_message_history_template = fs.readFileSync('pages/templates/channel/no_message_history.html', 'utf-8');

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || "");
}

function removeExistingEndAnchors(html) {
  return html.replace(/<a[^>]*(?:id=['"]end['"]|name=['"]end['"])[^>]*>[\s\S]*?<\/a>/gi, '');
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0.00 Bytes';
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

// Build the server icon list for the sidebar (mirrors server.js logic)
function buildServerList(discordID, bot, sessionParam) {
  let serverList = "";
  const data = auth.dbQueryAll("SELECT * FROM servers WHERE discordID=?", [discordID]);
  for (let serverData of data) {
    const serverID = serverData.serverID;
    const server = bot.client.guilds.cache.get(serverID);
    if (server) {
      let serverHTML = strReplace(server_icon_template, "{$SERVER_ICON_URL}", server.icon ? `/ico/server/${server.id}/${server.icon.startsWith("a_") ? server.icon.substring(2) : server.icon}.gif` : "/discord-mascot.gif");
      serverHTML = strReplace(serverHTML, "{$SERVER_URL}", "/server/" + server.id + (sessionParam || ''));
      let serverName = server.name.replace(/<a?:[^:]+:\d+>/g, '');
      serverName = serverName.replace(emojiRegex, '').trim();
      serverHTML = strReplace(serverHTML, "{$SERVER_NAME}", escape(normalizeWeirdUnicode(serverName)));
      serverList += serverHTML;
    }
  }
  return serverList;
}

// Apply theme and images preferences (mirrors server.js logic)
function applyUserPreferences(response, req) {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const urlTheme = parsedUrl.searchParams.get('theme');
  const whiteThemeCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('whiteThemeCookie='))?.split('=')[1];
  const theme = urlTheme !== null ? parseInt(urlTheme) : (whiteThemeCookie !== undefined ? parseInt(whiteThemeCookie) : 0);

  if (theme === 1) {
    response = response.replace("{$WHITE_THEME_ENABLED}", "class=\"light-theme\"");
  } else if (theme === 2) {
    response = response.replace("{$WHITE_THEME_ENABLED}", "class=\"amoled-theme\"");
  } else {
    response = response.replace("{$WHITE_THEME_ENABLED}", "bgcolor=\"303338\"");
  }

  const urlImages = parsedUrl.searchParams.get('images');
  const imagesCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('images='))?.split('=')[1];
  const imagesEnabled = urlImages !== null ? urlImages === '1' : (imagesCookie === '1' || imagesCookie === undefined);
  response = imagesEnabled ? response.replace("{$IMAGES_WARNING}", images_enabled_template) : response.replace("{$IMAGES_WARNING}", no_images_warning_template);

  return response;
}

// Build DM messages HTML for a DM channel (simplified, no guild lookups)
async function buildDMMessagesHtml(bot, chnl, discordID, imagesCookie, animationsCookie, clientTimezone) {
  const cachelength = 100;
  let messagesCollection;
  try {
    messagesCollection = await chnl.messages.fetch({ limit: cachelength });
  } catch (err) {
    console.error("Failed to fetch DM messages:", err);
    return no_message_history_template;
  }

  const messages = Array.from(messagesCollection.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const authorText = "#72767d";
  const replyText = "#b5bac1";

  let response = "";
  let lastauthor = undefined;
  let lastdate = new Date('1995-12-17T03:24:00');
  let lastmessagedate = null;
  let currentmessage = "";
  let islastmessage = false;
  let messageid = 0;

  const handlemessage = async function (item) {
    if (lastauthor) {
      if (islastmessage || (item && (lastauthor.id !== item.author.id || item.createdAt - lastdate > 420000))) {
        currentmessage = message_template.replace("{$MESSAGE_CONTENT}", currentmessage);
        currentmessage = strReplace(currentmessage, "{$MESSAGE_REPLY_LINK}", "");
        currentmessage = currentmessage.replace("{$MESSAGE_AUTHOR}", escape(getDisplayName(null, lastauthor)));
        currentmessage = strReplace(currentmessage, "{$AUTHOR_COLOR}", "#ffffff");
        currentmessage = strReplace(currentmessage, "{$REPLY_INDICATOR}", '');
        currentmessage = strReplace(currentmessage, "{$PING_INDICATOR}", '');
        currentmessage = strReplace(currentmessage, "{$MESSAGE_DATE}", formatDateWithTimezone(lastdate, clientTimezone));
        currentmessage = strReplace(currentmessage, "{$TAG}", '""');
        response += currentmessage;
        currentmessage = "";
      }
    }

    if (!item) return;

    if (clientTimezone && areDifferentDays(item.createdAt, lastmessagedate, clientTimezone)) {
      const separatorText = formatDateSeparator(item.createdAt, clientTimezone);
      response += date_separator_template.replace("{$DATE_SEPARATOR}", separatorText);
    }
    lastmessagedate = item.createdAt;

    let messagetext = renderDiscordMarkdown(item.content);

    // Emoji rendering
    if (imagesCookie === 1) {
      if (messagetext.match(emojiRegex)) {
        const unicode_emoji_matches = [...messagetext.match(emojiRegex)];
        unicode_emoji_matches.forEach(match => {
          const points = [];
          let char = 0, previous = 0, i = 0, output;
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
          messagetext = messagetext.replace(match, `<img src="/resources/twemoji/${output}.${emojiExt}" width="22" height="22" style="width: 1.375em; height: 1.375em; vertical-align: -0.2em;" alt="emoji" onerror="this.style.display='none'">`);
        });
      }
      const custom_emoji_matches = [...messagetext.matchAll(/&lt;(:)?(?:(a):)?(\w{2,32}):(\d{17,19})?(?:(?!\1).)*&gt;/g)];
      if (custom_emoji_matches.length > 0) {
        custom_emoji_matches.forEach(match => {
          const ext = match[2] ? "gif" : "png";
          messagetext = messagetext.replace(match[0], `<img src="/imageProxy/emoji/${match[4]}.${ext}" width="22" height="22" style="width: 1.375em; height: 1.375em; vertical-align: -0.2em;" alt="emoji" onerror="this.style.display='none'">`);
        });
      }
    }

    // Attachments
    if (item?.attachments) {
      let urls = [];
      item.attachments.forEach(attachment => {
        let url;
        if (attachment.name.match?.(/(?:\.(jpg|gif|png|jpeg|avif|svg|webp|tif|tiff))$/) && imagesCookie == 1) {
          url = "/imageProxy/".concat(attachment.url.replace(/^(.*?)(\d+)/, '$2'));
        } else if (attachment.name.match?.(/(?:\.(mp4|webm|mov|avi|mkv))$/) && imagesCookie == 1) {
          url = "/fileProxy/".concat(attachment.url.replace(/^(.*?)(\d+)/, '$2'));
          let tmpl = file_download_template;
          tmpl = tmpl.replace('{$FILE_NAME}', attachment.name.length > 30 ? attachment.name.replace(/(.*\.)(.*)$/, "$1").slice(0, 25) + "..." + attachment.name.replace(/(.*\.)(.*)$/, "$2") : attachment.name);
          tmpl = tmpl.replace('{$FILE_SIZE}', formatFileSize(attachment.size));
          messagetext = messagetext.concat(tmpl);
          urls.push(url);
          return;
        } else {
          url = "/fileProxy/".concat(attachment.url.replace(/^(.*?)(\d+)/, '$2'));
          let tmpl = file_download_template;
          tmpl = tmpl.replace('{$FILE_NAME}', attachment.name.length > 30 ? attachment.name.replace(/(.*\.)(.*)$/, "$1").slice(0, 25) + "..." + attachment.name.replace(/(.*\.)(.*)$/, "$2") : attachment.name);
          tmpl = tmpl.replace('{$FILE_SIZE}', formatFileSize(attachment.size));
          messagetext = messagetext.concat(tmpl);
        }
        urls.push(url);
      });
      urls.forEach(url => {
        url.match?.(/(?:\.(jpg|gif|png|jpeg|avif|svg|webp|tif|tiff))/) && imagesCookie == 1
          ? messagetext = messagetext.concat(`<br><a href="${url}" target="_blank"><img src="${url}" style="max-width:256px;max-height:200px;width:auto;height:auto;" alt="image"></a>`)
          : messagetext = messagetext.replace('{$FILE_LINK}', url);
      });
    }

    // Embeds
    if (item?.embeds && item.embeds.length > 0) {
      messagetext += processEmbeds(null, item.embeds, imagesCookie, animationsCookie, clientTimezone);
    }

    // Reactions
    const reactionsHtml = processReactions(item.reactions, imagesCookie, reactions_template, reaction_template, animationsCookie);

    const isNewAuthor = !lastauthor || lastauthor.id !== item.author.id || item.createdAt - lastdate > 420000;
    if (isNewAuthor) {
      messagetext = first_message_content_template.replace("{$MESSAGE_TEXT}", messagetext);
    } else {
      messagetext = merged_message_content_template.replace("{$MESSAGE_TEXT}", messagetext);
    }
    messagetext = strReplace(messagetext, "{$MESSAGE_REACTIONS}", reactionsHtml);

    const tempDiv = messagetext.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (tempDiv.length === 0 && (!item.attachments || item.attachments.size === 0) && (!item.embeds || item.embeds.length === 0)) {
      return;
    }

    lastauthor = item.author;
    lastdate = item.createdAt;
    currentmessage += messagetext;
    messageid = item.id;
  };

  for (const item of messages) {
    await handlemessage(item);
  }
  islastmessage = true;
  await handlemessage();

  response = removeExistingEndAnchors(response);
  response += '<a id="end" name="end"></a>';
  return response;
}

exports.processDM = async function (bot, req, res, args, discordID) {
  try {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
    const urlTheme = parsedUrl.searchParams.get('theme');
    const urlImages = parsedUrl.searchParams.get('images');

    const whiteThemeCookieForParam = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('whiteThemeCookie='))?.split('=')[1];
    const imagesCookieForParam = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('images='))?.split('=')[1];
    const animationsCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('animations='))?.split('=')[1];
    const animationsEnabled = animationsCookie !== undefined ? parseInt(animationsCookie) : 1;

    const linkParamParts = [];
    if (urlSessionID) linkParamParts.push('sessionID=' + encodeURIComponent(urlSessionID));
    if (urlTheme !== null && whiteThemeCookieForParam === undefined) linkParamParts.push('theme=' + encodeURIComponent(urlTheme));
    if (urlImages !== null && imagesCookieForParam === undefined) linkParamParts.push('images=' + encodeURIComponent(urlImages));
    const sessionParam = linkParamParts.length ? '?' + linkParamParts.join('&') : '';

    const imagesCookieValue = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('images='))?.split('=')[1];
    const imagesCookie = urlImages !== null ? parseInt(urlImages) : (imagesCookieValue !== undefined ? parseInt(imagesCookieValue) : 1);

    const clientIsReady = bot && bot.client && (typeof bot.client.isReady === 'function' ? bot.client.isReady() : !!bot.client.uptime);
    if (!clientIsReady) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.write("The bot isn't connected, try again in a moment");
      res.end();
      return;
    }

    const dmChannelId = args[2]; // undefined = DM list, set = specific DM channel

    if (dmChannelId) {
      // --- Show a specific DM channel ---
      let chnl;
      try {
        chnl = await bot.client.channels.fetch(dmChannelId);
      } catch (err) {
        chnl = undefined;
      }

      if (!chnl || chnl.type !== ChannelType.DM) {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.write("DM channel not found.");
        res.end();
        return;
      }

      const urlThemeVal = parsedUrl.searchParams.get('theme');
      const whiteThemeCookieVal = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('whiteThemeCookie='))?.split('=')[1];
      const theme = urlThemeVal !== null ? parseInt(urlThemeVal) : (whiteThemeCookieVal !== undefined ? parseInt(whiteThemeCookieVal) : 0);

      let boxColor = "#40444b";
      let tmpl;
      if (theme === 1) {
        boxColor = "#ffffff";
        tmpl = strReplace(dm_channel_template, "{$WHITE_THEME_ENABLED}", "class=\"light-theme\"");
      } else if (theme === 2) {
        tmpl = strReplace(dm_channel_template, "{$WHITE_THEME_ENABLED}", "class=\"amoled-theme\"");
      } else {
        tmpl = strReplace(dm_channel_template, "{$WHITE_THEME_ENABLED}", "");
      }

      const clientIP = getClientIP(req);
      const clientTimezone = getTimezoneFromIP(clientIP);

      const messagesHtml = await buildDMMessagesHtml(bot, chnl, discordID, imagesCookie, animationsEnabled, clientTimezone);

      // Recipient display name — fetch to get latest data, fall back to cached values
      let recipientName = "Unknown User";
      if (chnl.recipient) {
        try { await chnl.recipient.fetch(); } catch (_) {}
        recipientName = chnl.recipient.displayName || chnl.recipient.globalName || chnl.recipient.username || "Unknown User";
      }

      const input_template1 = strReplace(input_template, "{$COLOR}", boxColor)
        .replace("#{$CHANNEL_NAME}", "@{$CHANNEL_NAME}")
        .replace("{$CHANNEL_NAME}", escape(normalizeWeirdUnicode(recipientName)));

      const randomEmoji = ["1f62d", "1f480", "2764-fe0f", "1f44d", "1f64f", "1f389", "1f642"][Math.floor(Math.random() * 7)];
      let final = strReplace(tmpl, "{$INPUT}", input_template1);
      final = strReplace(final, "{$RANDOM_EMOJI}", randomEmoji);
      final = strReplace(final, "{$CHANNEL_NAME}", escape(normalizeWeirdUnicode(recipientName)));
      final = strReplace(final, "{$CHANNEL_ID}", chnl.id);
      final = strReplace(final, "{$MESSAGES}", messagesHtml);
      final = strReplace(final, "{$SESSION_ID}", urlSessionID);
      final = strReplace(final, "{$SESSION_PARAM}", sessionParam);
      final = strReplace(final, "{$REFRESH_URL}", `/dm/${chnl.id}?random=${Math.random()}${urlSessionID ? '&sessionID=' + encodeURIComponent(urlSessionID) : ''}`);

      res.writeHead(200, { "Content-Type": "text/html" });
      res.write(final);
      res.end();
    } else {
      // --- Show DM list page ---
      const serverList = buildServerList(discordID, bot, sessionParam);

      // Build the DM conversation list
      const dmChannels = bot.getDMChannels();
      let dmList = "";
      dmChannels.forEach(channel => {
        const recipient = channel.recipient;
        if (!recipient) return;
        const displayName = recipient.displayName || recipient.globalName || recipient.username || recipient.id;
        const username = recipient.username || recipient.id;
        // Show display name first, with username as fallback label
        const label = escape(normalizeWeirdUnicode(displayName || username));
        const sublabel = (displayName && displayName !== username) ? ` <font color="#72767d" size="2">(@${escape(username)})</font>` : '';
        dmList += `<a href="/dm/${channel.id}${sessionParam}" style="text-decoration: none;">` +
          `<font color="#dcddde" size="3" face="'rodin', Arial, Helvetica, sans-serif">` +
          `<span style="font-family: sans-serif; font-weight: bold; vertical-align: middle;">@</span>&nbsp;&nbsp;${label}${sublabel}` +
          `</font></a><br>`;
      });

      if (!dmList) {
        dmList = `<font color="#72767d" size="3" face="'rodin', Arial, Helvetica, sans-serif">No direct messages yet.</font><br>`;
      }

      const dmTitle = `<b><font color="#999999" size="5" face="'rodin', Arial, Helvetica, sans-serif">Direct Messages</font></b><br>`;
      const dmChannelContent = dmList +
        `<br><a class="discross-button" href="/server/${sessionParam}">Back to Servers</a>` +
        `<br><a class="discross-button" href="/switchtheme${sessionParam}">Switch Theme</a>`;

      let response = server_template.replace("{$SERVER_LIST}", serverList);
      response = response.replace("{$DISCORD_NAME}", dmTitle);
      response = response.replace("{$CHANNEL_LIST}", dmChannelContent);
      response = applyUserPreferences(response, req);
      response = response.split('{$SESSION_PARAM}').join(sessionParam);
      response = strReplace(response, "{$IMAGES_WARNING}", ""); // fallback if not replaced above
      response = strReplace(response, "{$USER_AGENT}", ""); // not used on DM list page

      res.writeHead(200, { "Content-Type": "text/html" });
      res.write(response);
      res.end();
    }
  } catch (err) {
    console.error("DM page error:", err);
    res.writeHead(500);
    res.write("An error occurred. Please try again.");
    res.end();
  }
};
