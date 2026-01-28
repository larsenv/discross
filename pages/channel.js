var fs = require('fs');
var HTMLMinifier = require('@bhavingajjar/html-minify');
var minifier = new HTMLMinifier();
var escape = require('escape-html');
var he = require('he');
const path = require('path');
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

const message_template = minifier.htmlMinify(fs.readFileSync('pages/templates/message/message.html', 'utf-8'));
const message_forwarded_template = minifier.htmlMinify(fs.readFileSync('pages/templates/message/forwarded_message.html', 'utf-8'));
const message_mentioned_template = minifier.htmlMinify(fs.readFileSync('pages/templates/message/message_mentioned.html', 'utf-8'));
const message_forwarded_mentioned_template = minifier.htmlMinify(fs.readFileSync('pages/templates/message/forwarded_message_mentioned.html', 'utf-8'));
const channel_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channel.html', 'utf-8'));
const first_message_content_template = minifier.htmlMinify(fs.readFileSync('pages/templates/message/first_message_content.html', 'utf-8'));
const merged_message_content_template = minifier.htmlMinify(fs.readFileSync('pages/templates/message/merged_message_content.html', 'utf-8'));
const mention_template = minifier.htmlMinify(fs.readFileSync('pages/templates/message/mention.html', 'utf-8'));

const input_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channel/input.html', 'utf-8'));
const input_disabled_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channel/input_disabled.html', 'utf-8'));

const no_message_history_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channel/no_message_history.html', 'utf-8'));

const file_download_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channel/file_download.html', 'utf-8'));

const reactions_template = minifier.htmlMinify(fs.readFileSync('pages/templates/message/reactions.html', 'utf-8'));
const reaction_template = minifier.htmlMinify(fs.readFileSync('pages/templates/message/reaction.html', 'utf-8'));
const date_separator_template = minifier.htmlMinify(fs.readFileSync('pages/templates/message/date_separator.html', 'utf-8'));
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

// Member utility functions (getDisplayName, getMemberColor, ensureMemberData) 
// are now imported from memberUtils.js to avoid duplication

// https://stackoverflow.com/questions/1967119/why-does-javascript-replace-only-first-instance-when-using-replace

exports.processChannel = async function processChannel(bot, req, res, args, discordID) {
  const imagesCookieValue = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('images='))?.split('=')[1];
  const imagesCookie = imagesCookieValue !== undefined ? parseInt(imagesCookieValue) : 1;  // Default to 1 (on)
   
  // Get client's timezone from IP
  const clientIP = getClientIP(req);
  const clientTimezone = getTimezoneFromIP(clientIP);
   
  try {
    let response, chnl;
    try {
      response = "";
      chnl = await bot.client.channels.fetch(args[2]);
    } catch (err) {
      chnl = undefined;
    }

    if (chnl) {
      const botMember = await chnl.guild.members.fetch(bot.client.user.id);
      const member = await chnl.guild.members.fetch(discordID);
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
        let template = strReplace(channel_template, "{$SERVER_ID}", chnl.guild.id)
        template = strReplace(template, "{$CHANNEL_ID}", chnl.id)

        let final;
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
      const messages = await bot.getHistoryCached(chnl);
      let lastauthor = undefined;
      let lastmember = undefined;
      let lastdate = new Date('1995-12-17T03:24:00');
      let lastmessagedate = null; // Track the last message date for day separator detection
      let currentmessage = "";
      let islastmessage = false;
      let messageid = 0;
      isForwarded = false;
      forwardData = {};
      isMentioned = false;
      isReply = false;
      replyData = {};
      lastMentioned = false;
      lastReply = false;
      lastReplyData = {};
        
      // Cache for member data to avoid repeated fetches
      const memberCache = new Map();

      const handlemessage = async function (item) { // Save the function to use later in the for loop and to process the last message
        if (lastauthor) { // Only consider the last message if this is not the first
          // If the last message is not going to be merged with this one, put it into the response
          if (islastmessage || lastauthor.id != item.author.id || lastauthor.username != item.author.username || item.createdAt - lastdate > 420000) {

            // Choose template based on whether this is a forwarded message and if user is mentioned
            if (isForwarded && lastMentioned) {
              currentmessage = message_forwarded_mentioned_template.replace("{$MESSAGE_CONTENT}", currentmessage);
              currentmessage = currentmessage.replace("{$FORWARDED_AUTHOR}", escape(forwardData.author));
              currentmessage = currentmessage.replace("{$FORWARDED_CONTENT}", forwardData.content);
              currentmessage = currentmessage.replace("{$FORWARDED_DATE}", forwardData.date);
            } else if (isForwarded) {
              currentmessage = message_forwarded_template.replace("{$MESSAGE_CONTENT}", currentmessage);
              currentmessage = currentmessage.replace("{$FORWARDED_AUTHOR}", escape(forwardData.author));
              currentmessage = currentmessage.replace("{$FORWARDED_CONTENT}", forwardData.content);
              currentmessage = currentmessage.replace("{$FORWARDED_DATE}", forwardData.date);
            } else if (lastMentioned) {
              currentmessage = message_mentioned_template.replace("{$MESSAGE_CONTENT}", currentmessage);
              currentmessage = currentmessage.replace("{$MESSAGE_REPLY_LINK}", "/channels/" + args[2] + "/" + messageid);
            } else {
              currentmessage = message_template.replace("{$MESSAGE_CONTENT}", currentmessage);
              currentmessage = currentmessage.replace("{$MESSAGE_REPLY_LINK}", "/channels/" + args[2] + "/" + messageid);
            }
            
            // Use helper functions for proper nickname and color
            const displayName = getDisplayName(lastmember, lastauthor);
            const authorColor = getMemberColor(lastmember);
            
            currentmessage = currentmessage.replace("{$MESSAGE_AUTHOR}", escape(displayName));
            currentmessage = strReplace(currentmessage, "{$AUTHOR_COLOR}", authorColor);
            
            // Add ping indicator (@) if this is a reply with ping
            const pingIndicator = (lastReply && lastReplyData.mentionsPing) ? ' <span style="color: #72767d;">@</span>' : '';
            currentmessage = strReplace(currentmessage, "{$PING_INDICATOR}", pingIndicator);
            
            // Add reply indicator (L-shaped line) if this is a reply
            let replyIndicator = '';
            if (lastReply) {
              replyIndicator = '<div style="display: flex; align-items: center; margin-bottom: 4px;">' +
                '<div style="width: 2px; height: 10px; background-color: #4e5058; border-radius: 2px 0 0 2px; margin-right: 4px;"></div>' +
                '<div style="width: 12px; height: 2px; background-color: #4e5058; border-radius: 0 0 0 2px; margin-right: 4px;"></div>' +
                '<span style="font-size: 12px; color: #b5bac1;">Replying to ' + escape(lastReplyData.author) + '</span>' +
                '</div>';
            }
            currentmessage = strReplace(currentmessage, "{$REPLY_INDICATOR}", replyIndicator);

            // Remove avatar URL processing since we removed avatars
            currentmessage = strReplace(currentmessage, "{$MESSAGE_DATE}", formatDateWithTimezone(lastdate, clientTimezone));
            currentmessage = strReplace(currentmessage, "{$TAG}", he.encode(JSON.stringify("<@" + lastauthor.id + ">")));
            response += currentmessage;
            currentmessage = "";
          }
        }

        if (!item) { // When processing the last message outside of the forEach item is undefined
          return;
        }
        
        // Check if we need to insert a date separator (when crossing day boundary)
        if (clientTimezone && areDifferentDays(item.createdAt, lastmessagedate, clientTimezone)) {
          // Day has changed (or first message), insert date separator
          const separatorText = formatDateSeparator(item.createdAt, clientTimezone);
          const separator = date_separator_template.replace("{$DATE_SEPARATOR}", separatorText);
          response += separator;
        }
        
        lastmessagedate = item.createdAt;

        // Check if this message is a forward and fetch forward data
        isForwarded = false;
        forwardData = {};
        if (item.reference?.type === MessageReferenceType.Forward) {
          try {
            const forwardedMessage = await item.fetchReference();
            const forwardedMember = await ensureMemberData(forwardedMessage, chnl.guild, memberCache);
            const forwardedAuthor = getDisplayName(forwardedMember, forwardedMessage.author);
            const forwardedContent = forwardedMessage.content.length > FORWARDED_CONTENT_MAX_LENGTH 
              ? forwardedMessage.content.substring(0, FORWARDED_CONTENT_MAX_LENGTH) + "..." 
              : forwardedMessage.content;
            const forwardedDate = formatDateWithTimezone(forwardedMessage.createdAt, clientTimezone);
            
            isForwarded = true;
            forwardData = {
              author: forwardedAuthor,
              content: renderDiscordMarkdown(forwardedContent), // UPDATED: Use custom renderer
              date: forwardedDate
            };
          } catch (err) {
            console.error("Could not fetch forwarded message:", err);
            // Fallback: show indicator but don't fail
            isForwarded = false;
          }
        }
        
        isReply = false;
        replyData = {};
        if (item.reference && !isForwarded) {
          try {
            let replyUser = item.mentions?.repliedUser; // Try getting from cache first
            let replyMember = undefined;
            let replyMessage = undefined;

            // Step 1: Try to fetch the full referenced message
            try {
              replyMessage = await item.fetchReference();
              replyUser = replyMessage.author; // Update user from the fresh fetch
            } catch (err) {
              // Message was likely deleted or is inaccessible. 
            }

            // Step 2: If we have a user (either from fetch or fallback), try to get Member data
            if (replyUser) {
              try {
                if (replyMessage) {
                  // If we have the full message, use your existing utility
                  replyMember = await ensureMemberData(replyMessage, chnl.guild, memberCache);
                } else {
                  // If we only have the User object (fallback), fetch member manually
                  if (memberCache.has(replyUser.id)) {
                    replyMember = memberCache.get(replyUser.id);
                  } else {
                    replyMember = await chnl.guild.members.fetch(replyUser.id);
                    memberCache.set(replyUser.id, replyMember);
                  }
                }
              } catch (err) {
                // Member fetch failed (User likely left the server). 
              }

              // Step 3: Construct the display data
              const replyAuthor = getDisplayName(replyMember, replyUser);
              const mentionsRepliedUser = item.mentions?.repliedUser !== undefined;

              isReply = true;
              replyData = {
                author: replyAuthor,
                authorId: replyUser.id,
                mentionsPing: mentionsRepliedUser
              };
            }
          } catch (err) {
            console.error("Could not process reply data:", err);
            isReply = false;
          }
        }

        messagetext = renderDiscordMarkdown(item.content); // UPDATED: Use custom renderer
        
        // Detect "Jumbo" Emoji status (<= 29 emojis and no other text)
        let isJumbo = false;
        if (imagesCookie == 1) {
            // Check raw content for "emoji only" status
            const customEmojiRegex = /<a?:.+?:\d{17,19}>/g;
            // Match custom emojis and unicode emojis
            const customMatches = item.content.match(customEmojiRegex) || [];
            const unicodeMatches = item.content.match(emojiRegex) || [];
            const totalEmojis = customMatches.length + unicodeMatches.length;
            
            // Remove all emojis and whitespace to see if anything else remains
            const strippedContent = item.content.replace(customEmojiRegex, '').replace(emojiRegex, '').trim();
            
            if (strippedContent.length === 0 && totalEmojis > 0 && totalEmojis <= 29) {
                isJumbo = true;
            }
        }

        // Standard size 1.375em. Jumbo size 2.75em (200%).
        // Note: 'em' is supported in IE3+ (1996), so it is very safe for "older browsers".
        const emojiSize = isJumbo ? "2.75em" : "1.375em";

        if (imagesCookie == 1) {
            // Process Unicode Emojis
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
                    messagetext = messagetext.replace(match, `<img src="/resources/twemoji/${output}.gif" style="width: ${emojiSize}; height: ${emojiSize}; vertical-align: -0.2em;" alt="emoji">`);
                 });
            }

            // Process Custom Emojis
            // Regex detects HTML escaped format &lt;:name:id&gt; which usually comes from renderDiscordMarkdown if not processed
            const custom_emoji_matches = [...messagetext.matchAll(/&lt;(:)?(?:(a):)?(\w{2,32}):(\d{17,19})?(?:(?!\1).)*&gt;?/g)];
            if (custom_emoji_matches.length > 0) {
                 custom_emoji_matches.forEach(match => {
                    // Convert to gif if animated (match[2] is 'a'), otherwise png. Or force gif for simplicity if proxy supports it.
                    // User requested animated to be lightweight and work, so we use the proxy logic.
                    const ext = match[2] ? "gif" : "png";
                    messagetext = messagetext.replace(match[0], `<img src="/imageProxy/emoji/${match[4]}.${ext}" style="width: ${emojiSize}; height: ${emojiSize}; vertical-align: -0.2em;" alt="emoji">`);
                 });
            }
        }

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
            url.match?.(/(?:\.(jpg|gif|png|jpeg|avif|gif|svg|webp|tif|tiff))/) && imagesCookie == 1 ? messagetext = messagetext.concat(`<br><a href="${url}" target="_blank"><img src="${url}" width="30%"  alt="image"></a>`) : messagetext = messagetext.replace('{$FILE_LINK}', url)
          });
        }
        
        // Process Stickers
        if (item.stickers && item.stickers.size > 0 && imagesCookie == 1) {
          item.stickers.forEach(sticker => {
             // Convert all stickers to GIF via proxy to ensure animation support and lightweight
             // Note: Discord stickers can be Lottie (json), PNG, or APNG. 
             // Requesting .gif from the proxy should trigger conversion if implemented on backend, or serve readable format.
             const stickerURL = `/imageProxy/sticker/${sticker.id}.gif`;
             messagetext += `<br><img src="${stickerURL}" style="width: 150px; height: 150px;" alt="sticker">`;
          });
        }

        // Check if current user is mentioned in this message
        isMentioned = false;
                
        // Process embeds (for bot messages)
        if (item?.embeds && item.embeds.length > 0) {
          messagetext += processEmbeds(item.embeds, imagesCookie);
        }
        
        // Process polls
        if (item?.poll) {
          messagetext += processPoll(item.poll, imagesCookie);
        }
        
        // Check for direct user mention
        if (item.mentions && item.mentions.members) {
          isMentioned = item.mentions.members.has(discordID);
        }
        
        // Check for reply with ping to current user
        if (!isMentioned && isReply && replyData.mentionsPing && replyData.authorId === discordID) {
          isMentioned = true;
        }
        
        // Check for @everyone or @here mention
        if (!isMentioned && item.mentions && item.mentions.everyone) {
          isMentioned = true;
        }
        
        // Check for role mention
        if (!isMentioned && item.mentions && item.mentions.roles) {
          item.mentions.roles.forEach(function (role) {
            if (member.roles.cache.has(role.id)) {
              isMentioned = true;
            }
          });
        }
        
        // Process user mentions
        if (item.mentions) {
          item.mentions.members.forEach(function (user) {
            if (user) {
              messagetext = strReplace(messagetext, "&lt;@" + user.id.toString() + "&gt;", mention_template.replace("{$USERNAME}", escape("@" + user.displayName)));
              messagetext = strReplace(messagetext, "&lt;@!" + user.id.toString() + "&gt;", mention_template.replace("{$USERNAME}", escape("@" + user.displayName)));
            }
          });
          
          // Handle role mentions
          if (item.mentions.roles) {
            item.mentions.roles.forEach(function (role) {
              if (role) {
                messagetext = strReplace(messagetext, "&lt;@&amp;" + role.id.toString() + "&gt;", mention_template.replace("{$USERNAME}", escape("@" + role.name)));
              }
            });
          }
        }
        
        // Handle any remaining user mentions (unknown users not in cache)
        messagetext = messagetext.replace(/&lt;@!?(\d{17,19})&gt;/g, function(match, userId) {
          // Try to find in guild members cache
          try {
            const cachedMember = chnl.guild.members.cache.get(userId);
            if (cachedMember) {
              return mention_template.replace("{$USERNAME}", escape("@" + cachedMember.displayName));
            }
          } catch (err) {
            // Ignore errors
          }
          // If not found, show as unknown-user
          return mention_template.replace("{$USERNAME}", "@unknown-user");
        });

        // https://stackoverflow.com/questions/6323417/regex-to-extract-all-matches-from-string-using-regexp-exec

        var regex = /&lt;#([0-9]{18})&gt;/g; // Regular expression to detect channel IDs
        var m;

        do {
          m = regex.exec(messagetext);
          if (m) {
            let channel;
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

        // Process @everyone and @here mentions
        if (item.mentions && item.mentions.everyone) {
          if (messagetext.includes("@everyone")) {
            messagetext = strReplace(messagetext, "@everyone", mention_template.replace("{$USERNAME}", "@everyone"));
          }
          if (messagetext.includes("@here")) {
            messagetext = strReplace(messagetext, "@here", mention_template.replace("{$USERNAME}", "@here"));
          }
        }

        // Process role mentions
        if (item.mentions && item.mentions.roles) {
          item.mentions.roles.forEach(function (role) {
            if (role) {
              messagetext = strReplace(messagetext, "&lt;@&amp;" + role.id + "&gt;", mention_template.replace("{$USERNAME}", escape("@" + role.name)));
            }
          });
        }

        // If the last message is not going to be merged with this one, use the template for the first message, otherwise use the template for merged messages
        if (!lastauthor || lastauthor.id != item.author.id || lastauthor.username != item.author.username || item.createdAt - lastdate > 420000) {
          messagetext = first_message_content_template.replace("{$MESSAGE_TEXT}", messagetext);
        } else {
          messagetext = merged_message_content_template.replace("{$MESSAGE_TEXT}", messagetext);
        }

        // Process and add reactions to the message
        const reactionsHtml = processReactions(item.reactions, imagesCookie, reactions_template, reaction_template);
        messagetext = strReplace(messagetext, "{$MESSAGE_REACTIONS}", reactionsHtml);

        lastauthor = item.author;
        // Ensure member data is populated - fetch if missing, using cache to avoid repeated fetches
        lastmember = await ensureMemberData(item, chnl.guild, memberCache);
        lastdate = item.createdAt;
        currentmessage += messagetext;
        messageid = item.id;
        
        // Save mention and reply state for next iteration
        lastMentioned = isMentioned;
        lastReply = isReply;
        lastReplyData = replyData;

      }

      for (const item of messages) {
        await handlemessage(item);
      }

      // Handle the last message
      // Uses the function in the foreach from earlier

      islastmessage = true;
      await handlemessage();

      let template = strReplace(channel_template, "{$SERVER_ID}", chnl.guild.id)
      template = strReplace(template, "{$CHANNEL_ID}", chnl.id)
      template = strReplace(template, "{$REFRESH_URL}", chnl.id + "?random=" + Math.random() + "#end")
      const whiteThemeCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('whiteThemeCookie='))?.split('=')[1];
        
      // Apply theme class based on cookie value: 0=dark (default), 1=light, 2=amoled
      if (whiteThemeCookie == 1) {
        template = strReplace(template, "{$WHITE_THEME_ENABLED}", "class=\"light-theme\"");
      } else if (whiteThemeCookie == 2) {
        template = strReplace(template, "{$WHITE_THEME_ENABLED}", "class=\"amoled-theme\"");
      } else {
        template = strReplace(template, "{$WHITE_THEME_ENABLED}", "");
      }

      let final;
      if (!botMember.permissionsIn(chnl).has(PermissionFlagsBits.ManageWebhooks, true)) {
        final = strReplace(template, "{$INPUT}", input_disabled_template);
        final = strReplace(final, "You don't have permission to send messages in this channel.", "Discross bot doesn't have the Manage Webhooks permission");
      } else if (member.permissionsIn(chnl).has(PermissionFlagsBits.SendMessages, true)) {
        final = strReplace(template, "{$INPUT}", input_template);
      } else {
        final = strReplace(template, "{$INPUT}", input_disabled_template);
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
      // Remove any existing end anchors from messages HTML before appending exactly one
      response = removeExistingEndAnchors(response);
      response += '<a id="end" name="end"></a>';
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
    // res.writeHead(302, { "Location": "/server/" });
    res.writeHead(500, { "Content-Type": "text/html" });
    res.write("An error occurred! Please try again later.<br>"); //write a response to the client
    // res.write(error.toString());
    res.end();
  }
}
