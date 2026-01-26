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
const { channel } = require('diagnostics_channel');
// const { console } = require('inspector'); // sorry idk why i added this
const fetch = require("sync-fetch");
const { getDisplayName, getMemberColor, ensureMemberData } = require('./memberUtils');
// Minify at runtime to save data on slow connections, but still allow editing the unminified file easily
// Is that a bad idea?

// Templates for viewing the messages in a channel
const channel_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channel.html', 'utf-8'));


const message_template = minifier.htmlMinify(fs.readFileSync('pages/templates/message/message.html', 'utf-8'));
const first_message_content_template = minifier.htmlMinify(fs.readFileSync('pages/templates/message/first_message_content.html', 'utf-8'));
const merged_message_content_template = minifier.htmlMinify(fs.readFileSync('pages/templates/message/merged_message_content.html', 'utf-8'));
const mention_template = minifier.htmlMinify(fs.readFileSync('pages/templates/message/mention.html', 'utf-8'));

const input_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channel/input.html', 'utf-8'));
const input_disabled_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channel/input_disabled.html', 'utf-8'));

const no_message_history_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channel/no_message_history.html', 'utf-8'));

const file_download_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channel/file_download.html', 'utf-8'));
const embed_template = minifier.htmlMinify(fs.readFileSync('pages/templates/message/embed.html', 'utf-8'));

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || "");
};

// Function to process Discord embeds
function processEmbeds(embeds, imagesCookie) {
  if (!embeds || embeds.length === 0) {
    return '';
  }
  
  let embedsHtml = '';
  
  embeds.forEach(embed => {
    let embedHtml = embed_template;
    
    // Set embed color (default to #202225 if not present)
    const embedColor = embed.color ? `#${embed.color.toString(16).padStart(6, '0')}` : '#202225';
    embedHtml = strReplace(embedHtml, '{$EMBED_COLOR}', embedColor);
    
    // Process embed author
    let authorHtml = '';
    if (embed.author) {
      authorHtml = '<div style="display: flex; align-items: center; margin-bottom: 8px;">';
      if (embed.author.iconURL && imagesCookie == 1) {
        authorHtml += `<img src="/imageProxy/${embed.author.iconURL.replace(/^.*?(\d+)/, '$1')}" style="width: 24px; height: 24px; border-radius: 50%; margin-right: 8px;" alt="author icon">`;
      }
      authorHtml += `<span style="font-size: 14px; font-weight: 600; color: #ffffff;">${escape(embed.author.name)}</span>`;
      if (embed.author.url) {
        authorHtml = `<a href="${escape(embed.author.url)}" target="_blank" style="text-decoration: none; color: inherit;">${authorHtml}</a>`;
      }
      authorHtml += '</div>';
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_AUTHOR}', authorHtml);
    
    // Process embed title
    let titleHtml = '';
    if (embed.title) {
      titleHtml = `<div style="font-size: 16px; font-weight: 600; color: #ffffff; margin-bottom: 8px;">`;
      if (embed.url) {
        titleHtml += `<a href="${escape(embed.url)}" target="_blank" style="color: #00b0f4; text-decoration: none;">${escape(embed.title)}</a>`;
      } else {
        titleHtml += escape(embed.title);
      }
      titleHtml += '</div>';
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_TITLE}', titleHtml);
    
    // Process embed description
    let descriptionHtml = '';
    if (embed.description) {
      descriptionHtml = `<div style="font-size: 14px; color: #dcddde; margin-bottom: 8px; white-space: pre-wrap;">${md.renderInline(embed.description)}</div>`;
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_DESCRIPTION}', descriptionHtml);
    
    // Process embed fields
    let fieldsHtml = '';
    if (embed.fields && embed.fields.length > 0) {
      fieldsHtml = '<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(0, 1fr)); gap: 8px; margin-bottom: 8px;">';
      embed.fields.forEach(field => {
        const fieldStyle = field.inline ? 'grid-column: span 1;' : 'grid-column: 1 / -1;';
        fieldsHtml += `<div style="${fieldStyle}">`;
        fieldsHtml += `<div style="font-size: 14px; font-weight: 600; color: #ffffff; margin-bottom: 4px;">${escape(field.name)}</div>`;
        fieldsHtml += `<div style="font-size: 14px; color: #dcddde; white-space: pre-wrap;">${md.renderInline(field.value)}</div>`;
        fieldsHtml += '</div>';
      });
      fieldsHtml += '</div>';
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_FIELDS}', fieldsHtml);
    
    // Process embed image
    let imageHtml = '';
    if (embed.image && embed.image.url && imagesCookie == 1) {
      imageHtml = `<div style="margin-top: 16px;"><a href="${escape(embed.image.url)}" target="_blank"><img src="/imageProxy/${embed.image.url.replace(/^.*?(\d+)/, '$1')}" style="max-width: 100%; border-radius: 4px;" alt="embed image"></a></div>`;
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_IMAGE}', imageHtml);
    
    // Process embed thumbnail
    let thumbnailHtml = '';
    if (embed.thumbnail && embed.thumbnail.url && imagesCookie == 1) {
      thumbnailHtml = `<div style="float: right; max-width: 80px; margin-left: 16px;"><img src="/imageProxy/${embed.thumbnail.url.replace(/^.*?(\d+)/, '$1')}" style="max-width: 100%; border-radius: 4px;" alt="thumbnail"></div>`;
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_THUMBNAIL}', thumbnailHtml);
    
    // Process embed footer
    let footerHtml = '';
    if (embed.footer || embed.timestamp) {
      footerHtml = '<div style="display: flex; align-items: center; margin-top: 8px; font-size: 12px; color: #72767d;">';
      if (embed.footer) {
        if (embed.footer.iconURL && imagesCookie == 1) {
          footerHtml += `<img src="/imageProxy/${embed.footer.iconURL.replace(/^.*?(\d+)/, '$1')}" style="width: 20px; height: 20px; border-radius: 50%; margin-right: 8px;" alt="footer icon">`;
        }
        footerHtml += `<span>${escape(embed.footer.text)}</span>`;
      }
      if (embed.timestamp) {
        if (embed.footer) {
          footerHtml += '<span style="margin: 0 4px;">•</span>';
        }
        const date = new Date(embed.timestamp);
        footerHtml += `<span>${date.toLocaleString('en-US')}</span>`;
      }
      footerHtml += '</div>';
    }
    embedHtml = strReplace(embedHtml, '{$EMBED_FOOTER}', footerHtml);
    
    embedsHtml += embedHtml;
  });
  
  return embedsHtml;
}

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
      messageid = 0;
      
      // Cache for member data to avoid repeated fetches
      const memberCache = new Map();

      handlemessage = async function (item) { // Save the function to use later in the for loop and to process the last message
        if (lastauthor) { // Only consider the last message if this is not the first
          // If the last message is not going to be merged with this one, put it into the response
          if (islastmessage || lastauthor.id != item.author.id || lastauthor.username != item.author.username || item.createdAt - lastdate > 420000) {


            currentmessage = message_template.replace("{$MESSAGE_CONTENT}", currentmessage);
            currentmessage = currentmessage.replace("{$MESSAGE_REPLY_LINK}", "/channels/" + args[2] + "/" + messageid);
            
            // Use helper functions for proper nickname and color
            const displayName = getDisplayName(lastmember, lastauthor);
            const authorColor = getMemberColor(lastmember);
            
            currentmessage = currentmessage.replace("{$MESSAGE_AUTHOR}", escape(displayName));
            currentmessage = strReplace(currentmessage, "{$AUTHOR_COLOR}", authorColor);

            // Remove avatar URL processing since we removed avatars
            currentmessage = strReplace(currentmessage, "{$MESSAGE_DATE}", lastdate.toLocaleTimeString('en-US') + " " + lastdate.toDateString());
            currentmessage = strReplace(currentmessage, "{$TAG}", he.encode(JSON.stringify("<@" + lastauthor.id + ">")));
            response += currentmessage;
            currentmessage = "";
          }
        }

        if (!item) { // When processing the last message outside of the forEach item is undefined
          return;
        }

        // messagetext = strReplace(escape(item.content), "\n", "<br>");
        messagetext = /* strReplace( */ md.renderInline(item.content) /* , "\n", "<br>") */;
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
        
        // Process embeds (for bot messages)
        if (item?.embeds && item.embeds.length > 0) {
          messagetext += processEmbeds(item.embeds, imagesCookie);
        }
        
        if (item.mentions) {
          item.mentions.members.forEach(function (user) {
            if (user) {
              messagetext = strReplace(messagetext, "&lt;@" + user.id.toString() + "&gt;", mention_template.replace("{$USERNAME}", escape("@" + user.displayName)));
              messagetext = strReplace(messagetext, "&lt;@!" + user.id.toString() + "&gt;", mention_template.replace("{$USERNAME}", escape("@" + user.displayName)));
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
        // Ensure member data is populated - fetch if missing, using cache to avoid repeated fetches
        lastmember = await ensureMemberData(item, chnl.guild, memberCache);
        lastdate = item.createdAt;
        currentmessage += messagetext;
        messageid = item.id;

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
      
      // Apply theme class based on cookie value: 0=dark (default), 1=light, 2=amoled
      if (whiteThemeCookie == 1) {
        response = strReplace(response, "{$WHITE_THEME_ENABLED}", "class=\"light-theme\"");
      } else if (whiteThemeCookie == 2) {
        response = strReplace(response, "{$WHITE_THEME_ENABLED}", "class=\"amoled-theme\"");
      } else {
        response = strReplace(response, "{$WHITE_THEME_ENABLED}", "");
      }

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
          response = response.replace(match, `<img src="/resources/twemoji/${output}.gif" style="width: 3%;vertical-align:top;" alt="emoji">`)
        });
      }

      const custom_emoji_matches = [...response.matchAll?.(/&lt;(:)?(?:(a):)?(\w{2,32}):(\d{17,19})?(?:(?!\1).)*&gt;?/g)];                // I'm not sure how to detect if an emoji is inline, since we don't have the whole message here to use it's length.
      if (custom_emoji_matches[0] && imagesCookie) custom_emoji_matches.forEach(async match => {                                                          // Tried Regex to find the whole message by matching the HTML tags that would appear before and after a message
        response = response.replace(match[0], `<img src="/imageProxy/emoji/${match[4]}.${match[2] ? "gif" : "png"}" style="width: 3%;"  alt="emoji">`)    // Make it smaller if inline
      })
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
