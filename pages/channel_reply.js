var fs = require('fs');
var HTMLMinifier = require('@bhavingajjar/html-minify');
var minifier = new HTMLMinifier();
var escape = require('escape-html');
var md = require('markdown-it')({ breaks: true, linkify: true });
var he = require('he'); // Encodes HTML attributes
const path = require('path');
const sharp = require("sharp");
const emojiRegex = require("./twemojiRegex").regex;
const sanitizer = require("path-sanitizer");
const { PermissionFlagsBits } = require('discord.js');
const auth = require('../authentication.js');
const fetch = require("sync-fetch");

// Minify at runtime to save data on slow connections, but still allow editing the unminified file easily
// Is that a bad idea?

// Templates for viewing the messages in a channel
// const channel_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channel.html', 'utf-8'));
const channel_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channel_reply.html', 'utf-8'));


const message_template = minifier.htmlMinify(fs.readFileSync('pages/templates/message/message_reply.html', 'utf-8'));
const first_message_content_template = minifier.htmlMinify(fs.readFileSync('pages/templates/message/first_message_content.html', 'utf-8'));
const merged_message_content_template = minifier.htmlMinify(fs.readFileSync('pages/templates/message/merged_message_content.html', 'utf-8'));
const mention_template = minifier.htmlMinify(fs.readFileSync('pages/templates/message/mention.html', 'utf-8'));
const mention_self_template = minifier.htmlMinify(fs.readFileSync('pages/templates/message/mention_self.html', 'utf-8'));

const input_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channel/input.html', 'utf-8'));
const input_disabled_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channel/input_disabled.html', 'utf-8'));

const no_message_history_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channel/no_message_history.html', 'utf-8'));

const file_download_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channel/file_download.html', 'utf-8'));

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || "");
};

function getAuthorInitial(displayName) {
  if (!displayName) return "?";
  return displayName.charAt(0).toUpperCase();
}

function getUserRoleColor(member) {
  if (!member || !member.roles) return "#ffffff";
  
  // Get the highest role with a color
  const roles = member.roles.cache.filter(role => role.color !== 0);
  if (roles.size === 0) return "#ffffff";
  
  const highestRole = roles.sort((a, b) => b.position - a.position).first();
  return `#${highestRole.color.toString(16).padStart(6, '0')}`;
}

function getDisplayName(member, author) {
  if (!member) return author.username;
  
  // Use nickname if available, otherwise display name, otherwise username
  return member.nickname || member.displayName || author.username;
}

function formatMessageDate(date, req) {
  // Try to detect timezone from the request or use UTC as fallback
  let timezone = 'UTC';
  
  // Check for timezone in cookies or headers (this would be set by frontend JavaScript)
  const timezoneCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('timezone='))?.split('=')[1];
  if (timezoneCookie) {
    timezone = decodeURIComponent(timezoneCookie);
  }
  
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
    
    return formatter.format(date);
  } catch (err) {
    // Fallback to UTC if timezone detection fails
    return date.toLocaleString('en-US', { timeZone: 'UTC' });
  }
}

function processDiscordMarkdown(content) {
  // Handle large text (# prefix) 
  if (content.startsWith('# ')) {
    const largeText = content.substring(2);
    return `<div style="font-size: 32px; font-weight: 700; line-height: 36px; margin: 8px 0;">${escape(largeText)}</div>`;
  }

  // Check if content is only emoji (for larger emoji rendering)
  const emojiOnlyRegex = /^[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\s]*$/u;
  const isEmojiOnly = emojiOnlyRegex.test(content) && content.trim().length > 0;

  // Process with markdown-it first
  let processed = md.renderInline(content);
  
  // Enhance with Discord-specific styling
  // Bold text **text** or __text__
  processed = processed.replace(/\*\*(.*?)\*\*/g, '<strong style="font-weight: 700;">$1</strong>');
  processed = processed.replace(/__(.*?)__/g, '<strong style="font-weight: 700;">$1</strong>');
  
  // Italic text *text* or _text_
  processed = processed.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em style="font-style: italic;">$1</em>');
  processed = processed.replace(/(?<!_)_([^_]+)_(?!_)/g, '<em style="font-style: italic;">$1</em>');
  
  // Strikethrough text ~~text~~
  processed = processed.replace(/~~(.*?)~~/g, '<span style="text-decoration: line-through;">$1</span>');
  
  // Inline code `code`
  processed = processed.replace(/`([^`]+)`/g, '<code style="background: #2f3136; color: #dcddde; padding: 2px 4px; border-radius: 3px; font-family: Consolas, Monaco, \'Courier New\', monospace; font-size: 14px;">$1</code>');
  
  // Code blocks ```code```
  processed = processed.replace(/```([\s\S]*?)```/g, '<pre style="background: #2f3136; color: #dcddde; padding: 8px; border-radius: 4px; font-family: Consolas, Monaco, \'Courier New\', monospace; font-size: 14px; overflow-x: auto; white-space: pre-wrap;"><code>$1</code></pre>');
  
  // Spoiler text ||text||
  processed = processed.replace(/\|\|(.*?)\|\|/g, '<span style="background: #202225; color: #202225; border-radius: 4px; padding: 0 2px; cursor: pointer;" onclick="this.style.color=\'#dcddde\'" title="Click to reveal spoiler">$1</span>');
  
  // Store emoji-only info for later processing
  if (isEmojiOnly) {
    processed = `<div class="emoji-only-message">${processed}</div>`;
  }
  
  return processed;
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0.00 Bytes';
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const formattedSize = (bytes / Math.pow(1024, i)).toFixed(2);
  return `${formattedSize} ${sizes[i]}`;
}

// https://stackoverflow.com/questions/1967119/why-does-javascript-replace-only-first-instance-when-using-replace

exports.processChannelReply = async function processChannelReply(bot, req, res, args, discordID) {
  const imagesCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('images='))?.split('=')[1];
  try {
    try {
      response = "";
      chnl = await bot.client.channels.fetch(args[2]);
    } catch (err) {
      chnl = undefined;
    }

    if (chnl) {
      botMember = await chnl.guild.members.fetch(bot.client.user.id)
      member = await chnl.guild.members.fetch(discordID);
      user = member.user;
      username = user.tag;
      if (member.displayName != user.username) {
        username = member.displayName + " (@" + user.tag + ")";
      }

      if (!member.permissionsIn(chnl).has(PermissionFlagsBits.ViewChannel, true) || !botMember.permissionsIn(chnl).has(PermissionFlagsBits.ViewChannel, true)) {
        res.write("You (or the bot) don't have permission to do that!");
        res.end();
        return;
      }

      if (!member.permissionsIn(chnl).has(PermissionFlagsBits.ReadMessageHistory, true)) {
        template = strReplace(channel_template, "{$SERVER_ID}", chnl.guild.id)
        template = strReplace(template, "{$CHANNEL_ID}", chnl.id)

        if (member.permissionsIn(chnl).has(PermissionFlagsBits.SendMessages, true)) {
          final = strReplace(template, "{$INPUT}", input_template);
        } else {
          final = strReplace(template, "{$INPUT}", input_disabled_template);
        }
        final = strReplace(final, "{$MESSAGES}", no_message_history_template);

        res.write(final); //write a response to the client
        res.end(); //end the response
        return;
      }

      console.log("Processed valid channel request");
      messages = await bot.getHistoryCached(chnl);
      lastauthor = undefined;
      lastmember = undefined;
      lastdate = new Date('1995-12-17T03:24:00');
      currentmessage = "";
      islastmessage = false;

      handlemessage = async function (item) { // Save the function to use later in the for loop and to process the last message
        if (lastauthor) { // Only consider the last message if this is not the first
          // If the last message is not going to be merged with this one, put it into the response
          if (islastmessage || lastauthor.id != item.author.id || lastauthor.username != item.author.username || item.createdAt - lastdate > 420000) {


            currentmessage = message_template.replace("{$MESSAGE_CONTENT}", currentmessage);
            if (lastmember) { // Webhooks are not members!
              const displayName = getDisplayName(lastmember, lastauthor);
              const roleColor = getUserRoleColor(lastmember);
              currentmessage = currentmessage.replace("{$MESSAGE_AUTHOR}", escape(displayName));
              currentmessage = currentmessage.replace("{$MESSAGE_AUTHOR_INITIAL}", getAuthorInitial(displayName));
              currentmessage = currentmessage.replace("{$MESSAGE_AUTHOR_COLOR}", roleColor);
            } else {
              currentmessage = currentmessage.replace("{$MESSAGE_AUTHOR}", escape(lastauthor.username));
              currentmessage = currentmessage.replace("{$MESSAGE_AUTHOR_INITIAL}", getAuthorInitial(lastauthor.username));
              currentmessage = currentmessage.replace("{$MESSAGE_AUTHOR_COLOR}", "#ffffff");
            }

            var url = lastauthor.avatarURL();
            if (lastauthor.avatarURL && url && url.toString().startsWith("http")) { // Sometimes the URL is null or something else
              currentmessage = currentmessage.replace("{$PROFILE_URL}", url);
            }
            currentmessage = strReplace(currentmessage, "{$MESSAGE_DATE}", formatMessageDate(lastdate, req));
            currentmessage = strReplace(currentmessage, "{$TAG}", he.encode(JSON.stringify("<@" + lastauthor.id + ">")));
            response += currentmessage;
            currentmessage = "";
          }
        }

        if (!item) { // When processing the last message outside of the forEach item is undefined
          return;
        }

        // messagetext = strReplace(escape(item.content), "\n", "<br>");
        messagetext = processDiscordMarkdown(item.content);
        if (item?.attachments) {
          let urls = new Array()
          item.attachments.forEach(attachment => {
            let url
            if (attachment.name.match?.(/(?:\.(jpg|gif|png|jpeg|avif|gif|svg|webp|tif|tiff))$/) && imagesCookie == 1) {
              url = "/imageProxy/".concat(attachment.url.replace(/^(.*?)(\d+)/, '$2'))
            } else {
              url = "/fileProxy/".concat(attachment.url.replace(/^(.*?)(\d+)/, '$2'))
              messagetext = messagetext.concat(file_download_template)
              messagetext = messagetext.replace('{$FILE_NAME}', attachment.name.length > 30 ? attachment.name.replace(/(.*\.)(.*)$/, "$1").slice(0, 25) + "..." + attachment.name.replace(/(.*\.)(.*)$/, "$2") : attachment.name)
              messagetext = messagetext.replace('{$FILE_SIZE}', formatFileSize(attachment.size))
            }
            urls.push(url)
          });
          urls.forEach(url => {
            url.match?.(/(?:\.(jpg|gif|png|jpeg|avif|gif|svg|webp|tif|tiff))/) && imagesCookie == 1 ? messagetext = messagetext.concat(`<br><a href="${url}" target="_blank"><img src="${url}" style="max-width: 400px; width: 100%; height: auto; border-radius: 4px; margin: 4px 0;" alt="image"></a>`) : messagetext = messagetext.replace('{$FILE_LINK}', url)
          });
        }
        
        // Process Discord embeds
        if (item?.embeds && item.embeds.length > 0 && imagesCookie == 1) {
          item.embeds.forEach(embed => {
            let embedHTML = '<div style="border-left: 4px solid #5865f2; background: #2f3136; margin: 8px 0; padding: 12px; border-radius: 4px; max-width: 400px;">';
            
            if (embed.title) {
              const titleText = embed.url ? 
                `<a href="${escape(embed.url)}" style="color: #00aff4; text-decoration: none; font-weight: 600;">${escape(embed.title)}</a>` : 
                `<span style="color: #ffffff; font-weight: 600;">${escape(embed.title)}</span>`;
              embedHTML += `<div style="margin-bottom: 8px;">${titleText}</div>`;
            }
            
            if (embed.description) {
              embedHTML += `<div style="color: #dcddde; font-size: 14px; margin-bottom: 8px;">${escape(embed.description)}</div>`;
            }
            
            if (embed.image?.url) {
              embedHTML += `<img src="/imageProxy/${embed.image.url.replace(/^(.*?)(\d+)/, '$2')}" style="max-width: 100%; height: auto; border-radius: 4px; margin-top: 8px;" alt="Embed image">`;
            }
            
            if (embed.thumbnail?.url) {
              embedHTML += `<img src="/imageProxy/${embed.thumbnail.url.replace(/^(.*?)(\d+)/, '$2')}" style="width: 80px; height: 80px; object-fit: cover; border-radius: 4px; float: right; margin-left: 12px;" alt="Embed thumbnail">`;
            }
            
            if (embed.footer?.text) {
              embedHTML += `<div style="color: #72767d; font-size: 12px; margin-top: 8px;">${escape(embed.footer.text)}</div>`;
            }
            
            embedHTML += '</div>';
            messagetext += embedHTML;
          });
        }
        
        if (item.mentions) {
          item.mentions.members.forEach(function (user) {
            if (user) {
              // Use yellow highlighting if this is a mention of the current user
              const isCurrentUser = user.id === discordID;
              const template = isCurrentUser ? mention_self_template : mention_template;
              const displayName = getDisplayName(user, user.user);
              messagetext = strReplace(messagetext, "&lt;@" + user.id.toString() + "&gt;", template.replace("{$USERNAME}", escape("@" + displayName)));
              messagetext = strReplace(messagetext, "&lt;@!" + user.id.toString() + "&gt;", template.replace("{$USERNAME}", escape("@" + displayName)));
            }
          });
        }

        // https://stackoverflow.com/questions/6323417/regex-to-extract-all-matches-from-string-using-regexp-exec

        var regex = /&lt;#([0-9]{18})&gt;/g; // Regular expression to detect channel IDs
        var m;

        do {
          m = regex.exec(messagetext);
          if (m) {
            try {
              channel = await bot.client.channels.cache.get(m[1]);
            } catch (err) {
              console.log(err);
            }
            if (channel) {
              messagetext = strReplace(messagetext, m[0], mention_template.replace("{$USERNAME}", escape("#" + channel.name)));
            }
          }
        } while (m);

        messagetext = strReplace(messagetext, "@everyone", mention_template.replace("{$USERNAME}", "@everyone"));
        messagetext = strReplace(messagetext, "@here", mention_template.replace("{$USERNAME}", "@here"));



        // If the last message is not going to be merged with this one, use the template for the first message, otherwise use the template for merged messages
        if (!lastauthor || lastauthor.id != item.author.id || lastauthor.username != item.author.username || item.createdAt - lastdate > 420000) {
          messagetext = first_message_content_template.replace("{$MESSAGE_TEXT}", messagetext);
        } else {
          messagetext = merged_message_content_template.replace("{$MESSAGE_TEXT}", messagetext);
        }

        lastauthor = item.author;
        lastmember = item.member;
        lastdate = item.createdAt;
        currentmessage += messagetext;

      }

      for (const item of messages) {
        await handlemessage(item);
      }

      // Handle the last message
      // Uses the function in the foreach from earlier

      islastmessage = true;
      await handlemessage();

      template = strReplace(channel_template, "{$SERVER_ID}", chnl.guild.id)
      template = strReplace(template, "{$CHANNEL_ID}", chnl.id)
      template = strReplace(template, "{$REFRESH_URL}", chnl.id + "?random=" + Math.random() + "#end")
      const whiteThemeCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('whiteThemeCookie='))?.split('=')[1];
      whiteThemeCookie == 1 ? response = strReplace(response, "{$WHITE_THEME_ENABLED}", "class=\"light-theme\"") : response = strReplace(response, "{$WHITE_THEME_ENABLED}", "")

      if (!botMember.permissionsIn(chnl).has(PermissionFlagsBits.ManageWebhooks, true)) {
        final = strReplace(template, "{$INPUT}", input_disabled_template);
        final = strReplace(final, "You don't have permission to send messages in this channel.", "Discross bot doesn't have the Manage Webhooks permission");
      } else if (member.permissionsIn(chnl).has(PermissionFlagsBits.SendMessages, true)) {
        final = strReplace(template, "{$INPUT}", input_template);
      } else {
        final = strReplace(template, "{$INPUT}", input_disabled_template);
      }

      if (response.match?.(emojiRegex) && imagesCookie == 1) {
        const unicode_emoji_matches = [...response.match?.(emojiRegex)]
        unicode_emoji_matches.forEach(match => {
          const points = [];
          let char = 0;
          let previous = 0;                  // This whole code block was "inspired" by the official Twitter Twemoji parser.
          let i = 0;                         // I would have done it myself but my code wasn't ready for skin tones/emoji variation
          let output                         // The Regex I wouldn't have done myself, so thanks for that too!
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
            output = points.join("-")
          }
          // Check if this emoji is in an emoji-only message for larger sizing
          const isInEmojiOnlyMessage = response.includes('<div class="emoji-only-message">');
          const emojiSize = isInEmojiOnlyMessage ? "6%" : "3%";
          response = response.replace(match, `<img src="/resources/twemoji/${output}.gif" style="width: ${emojiSize}; vertical-align: top;" alt="emoji">`)
        });
      }

      const custom_emoji_matches = [...response.matchAll?.(/&lt;(:)?(?:(a):)?(\w{2,32}):(\d{17,19})?(?:(?!\1).)*&gt;?/g)];
      if (custom_emoji_matches[0] && imagesCookie) custom_emoji_matches.forEach(async match => {
        // Check if this emoji is in an emoji-only message for larger sizing
        const isInEmojiOnlyMessage = response.includes('<div class="emoji-only-message">');
        const emojiSize = isInEmojiOnlyMessage ? "6%" : "3%";
        response = response.replace(match[0], `<img src="/imageProxy/emoji/${match[4]}.${match[2] ? "gif" : "png"}" style="width: ${emojiSize};" alt="emoji">`)
      })
      let reply_message_id = args[3];

      try {
        let message = await chnl.messages.fetch(reply_message_id);
        let message_content = message.content;
        if (message_content.length > 30) {
          message_content = message.content.substring(0, 30) + "...";
        }
        let author = message.author.username;
        final = strReplace(final, "{$REPLY_MESSAGE_ID}", reply_message_id);
        final = strReplace(final, "{$REPLY_MESSAGE_AUTHOR}", author);
        final = strReplace(final, "{$REPLY_MESSAGE_CONTENT}", message_content);
      } catch (err) {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.write("Invalid message!"); //write a response to the client
        res.end(); //end the response
        return
      }
      const randomEmoji = ["1f62d", "1f480", "2764-fe0f", "1f44d", "1f64f", "1f389", "1f642"][Math.floor(Math.random() * 7)];
      final = strReplace(final, "{$RANDOM_EMOJI}", randomEmoji);
      final = strReplace(final, "{$CHANNEL_NAME}", chnl.name);
      const tensorLinksRegex = /<a href="https:\/\/tenor\.com\/view\/([A-Za-z0-9]+(-[A-Za-z0-9]+)+)">https:\/\/tenor\.com\/view\/([A-Za-z0-9]+(-[A-Za-z0-9]+)+)<\/a>/g;
      let tmpTensorLinks = [...response.toString().matchAll(tensorLinksRegex)];
      let resp_,gifLink,description;
      tmpTensorLinks.forEach(link => {
        resp_ = fetch("https://g.tenor.com/v1/gifs?ids=" + link[0].toString().split("-").at(-1).replace(/<\/a>/, "") + "&key=LIVDSRZULELA");
        try { resp_ = resp_.json();
          gifLink = resp_["results"][0]["media"][0]["tinygif"]["url"];
          description = resp_["results"][0]["content_description"];}
        catch { return }
        response = response.replace(link[0], "<img src=\"" + gifLink + "\" alt=\"" + description + "\">");
      });
      final = strReplace(final, "{$MESSAGES}", response);

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
    res.writeHead(302, { "Location": "/server/" });
    res.end();
  }
}
