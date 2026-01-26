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
// Minify at runtime to save data on slow connections, but still allow editing the unminified file easily
// Is that a bad idea?

// Templates for viewing the messages in a channel
const channel_template = fs.readFileSync('pages/templates/draw.html', 'utf-8');

const message_template = fs.readFileSync('pages/templates/message/message.html', 'utf-8');
const first_message_content_template = fs.readFileSync('pages/templates/message/first_message_content.html', 'utf-8');
const merged_message_content_template = fs.readFileSync('pages/templates/message/merged_message_content.html', 'utf-8');
const mention_template = fs.readFileSync('pages/templates/message/mention.html', 'utf-8');

const input_template = fs.readFileSync('pages/templates/channel/input.html', 'utf-8');
const input_disabled_template = fs.readFileSync('pages/templates/channel/input_disabled.html', 'utf-8');

const no_message_history_template = fs.readFileSync('pages/templates/channel/no_message_history.html', 'utf-8');

const file_download_template = fs.readFileSync('pages/templates/channel/file_download.html', 'utf-8');

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

// Get the display name following Discord's order: server nickname -> Discord username -> internal username
function getDisplayName(member, author) {
  if (member) {
    // Server nickname (guild nickname) first
    if (member.nickname) {
      return member.nickname;
    }
    // Otherwise Discord username (from user object)
    if (member.user && member.user.globalName) {
      return member.user.globalName;
    }
    if (member.user && member.user.username) {
      return member.user.username;
    }
    // Fallback to member display name
    return member.displayName;
  }
  
  // For webhooks or when no member data, use author data
  if (author) {
    if (author.globalName) {
      return author.globalName;
    }
    return author.username;
  }
  
  return "Unknown User";
}

// Get the member's highest role color or default to white
function getMemberColor(member) {
  if (!member || !member.roles || !member.roles.highest) {
    return "#ffffff"; // Default white color
  }
  
  const roleColor = member.roles.highest.color;
  if (roleColor === 0) {
    return "#ffffff"; // Default role has color 0, use white
  }
  
  // Convert Discord color integer to hex
  return `#${roleColor.toString(16).padStart(6, '0')}`;
}

// https://stackoverflow.com/questions/1967119/why-does-javascript-replace-only-first-instance-when-using-replace

exports.processDraw = async function processDraw(bot, req, res, args, discordID) {
  const imagesCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('images='))?.split('=')[1];
  try {
    // FIX 1: Declare all variables with 'let' to prevent "Assignment to constant variable" errors
    let response = "";
    let chnl;
    let botMember;
    let member;
    let user;
    let username;
    let template;
    let final;
    let messages;

    try {
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

        // Note: The template likely won't have {$INPUT} if using the canvas template, so this replace might just do nothing, which is fine.
        if (member.permissionsIn(chnl).has(PermissionFlagsBits.SendMessages, true)) {
          final = strReplace(template, "{$INPUT}", input_template);
        } else {
          final = strReplace(template, "{$INPUT}", input_disabled_template);
        }
        final = strReplace(final, "{$MESSAGES}", no_message_history_template);

        res.write(final);
        res.end();
        return;
      }

      // console.log("Processed valid channel request");
      messages = await bot.getHistoryCached(chnl);
      
      // FIX 2: Declare loop variables with 'let'
      let lastauthor = undefined;
      let lastmember = undefined;
      let lastdate = new Date('1995-12-17T03:24:00');
      let currentmessage = "";
      let islastmessage = false;
      let messageid = 0;

      // Define the handler function
      const handlemessage = async function (item) { 
        if (lastauthor) { 
          if (islastmessage || lastauthor.id != item.author.id || lastauthor.username != item.author.username || item.createdAt - lastdate > 420000) {

            currentmessage = message_template.replace("{$MESSAGE_CONTENT}", currentmessage);
            currentmessage = currentmessage.replace("{$MESSAGE_REPLY_LINK}", "/channels/" + args[2] + "/" + messageid);
            
            const displayName = getDisplayName(lastmember, lastauthor);
            const authorColor = getMemberColor(lastmember);
            
            currentmessage = currentmessage.replace("{$MESSAGE_AUTHOR}", escape(displayName));
            currentmessage = strReplace(currentmessage, "{$AUTHOR_COLOR}", authorColor);
            currentmessage = strReplace(currentmessage, "{$MESSAGE_DATE}", lastdate.toLocaleTimeString('en-US') + " " + lastdate.toDateString());
            currentmessage = strReplace(currentmessage, "{$TAG}", he.encode(JSON.stringify("<@" + lastauthor.id + ">")));
            
            response += currentmessage; // This assignment was failing before
            currentmessage = "";
          }
        }

        if (!item) return;

        let messagetext = md.renderInline(item.content);
        
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
        
        if (item.mentions) {
          item.mentions.members.forEach(function (user) {
            if (user) {
              messagetext = strReplace(messagetext, "&lt;@" + user.id.toString() + "&gt;", mention_template.replace("{$USERNAME}", escape("@" + user.displayName)));
              messagetext = strReplace(messagetext, "&lt;@!" + user.id.toString() + "&gt;", mention_template.replace("{$USERNAME}", escape("@" + user.displayName)));
            }
          });
        }

        var regex = /&lt;#([0-9]{18})&gt;/g; 
        var m;

        do {
          m = regex.exec(messagetext);
          if (m) {
            let mentionedChannel; // FIX 3: Renamed to avoid conflict with global/module 'channel'
            try {
              mentionedChannel = await bot.client.channels.cache.get(m[1]);
            } catch (err) {
              console.log(err);
            }
            if (mentionedChannel) {
              messagetext = strReplace(messagetext, m[0], mention_template.replace("{$USERNAME}", escape("#" + mentionedChannel.name)));
            }
          }
        } while (m);

        messagetext = strReplace(messagetext, "@everyone", mention_template.replace("{$USERNAME}", "@everyone"));
        messagetext = strReplace(messagetext, "@here", mention_template.replace("{$USERNAME}", "@here"));

        if (!lastauthor || lastauthor.id != item.author.id || lastauthor.username != item.author.username || item.createdAt - lastdate > 420000) {
          messagetext = first_message_content_template.replace("{$MESSAGE_TEXT}", messagetext);
        } else {
          messagetext = merged_message_content_template.replace("{$MESSAGE_TEXT}", messagetext);
        }

        lastauthor = item.author;
        lastmember = item.member;
        lastdate = item.createdAt;
        currentmessage += messagetext;
        messageid = item.id;
      }

      for (const item of messages) {
        await handlemessage(item);
      }

      islastmessage = true;
      await handlemessage();

      template = strReplace(channel_template, "{$SERVER_ID}", chnl.guild.id)
      template = strReplace(template, "{$CHANNEL_ID}", chnl.id)
      template = strReplace(template, "{$REFRESH_URL}", chnl.id + "?random=" + Math.random() + "#end")
      const whiteThemeCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('whiteThemeCookie='))?.split('=')[1];
      
      if (whiteThemeCookie == 1) {
        response = strReplace(response, "{$WHITE_THEME_ENABLED}", "class=\"light-theme\"");
      } else if (whiteThemeCookie == 2) {
        response = strReplace(response, "{$WHITE_THEME_ENABLED}", "class=\"amoled-theme\"");
      } else {
        response = strReplace(response, "{$WHITE_THEME_ENABLED}", "");
      }

      // Remove the {$INPUT} replacement logic here if you want to strictly use the canvas from the template
      // But keeping it is fine as long as the template doesn't have the {$INPUT} tag.
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
          let previous = 0;                  
          let i = 0;                         
          let output                         
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

      const custom_emoji_matches = [...response.matchAll?.(/&lt;(:)?(?:(a):)?(\w{2,32}):(\d{17,19})?(?:(?!\1).)*&gt;?/g)];                
      if (custom_emoji_matches[0] && imagesCookie) custom_emoji_matches.forEach(async match => {                                                          
        response = response.replace(match[0], `<img src="/imageProxy/emoji/${match[4]}.${match[2] ? "gif" : "png"}" style="width: 3%;"  alt="emoji">`)    
      })

      const randomEmoji = ["1f62d", "1f480", "2764-fe0f", "1f44d", "1f64f", "1f389", "1f642"][Math.floor(Math.random() * 7)];
      final = strReplace(final, "{$RANDOM_EMOJI}", randomEmoji);
      final = strReplace(final, "{$CHANNEL_NAME}", chnl.name);
      
      const tensorLinksRegex = /<a href="https:\/\/tenor\.com\/view\/([A-Za-z0-9]+(-[A-Za-z0-9]+)+)">https:\/\/tenor\.com\/view\/([A-Za-z0-9]+(-[A-Za-z0-9]+)+)<\/a>/g;
      let tmpTensorLinks = [...response.toString().matchAll(tensorLinksRegex)];
      let resp_, gifLink, description;
      
      tmpTensorLinks.forEach(link => {
        try {
            // Add a synchronous fetch wrapper or ensure this works synchronously if you aren't awaiting
            // Assuming sync-fetch based on imports
            resp_ = fetch("https://g.tenor.com/v1/gifs?ids=" + link[0].toString().split("-").at(-1).replace(/<\/a>/, "") + "&key=LIVDSRZULELA");
            resp_ = resp_.json();
            gifLink = resp_["results"][0]["media"][0]["tinygif"]["url"];
            description = resp_["results"][0]["content_description"];
            response = response.replace(link[0], "<img src=\"" + gifLink + "\" alt=\"" + description + "\">");
        } catch (e) { 
            return; 
        }
      });

      response = removeExistingEndAnchors(response);
      response += '<a id="end" name="end"></a>';
      final = strReplace(final, "{$MESSAGES}", response);
      
      res.writeHead(200, { "Content-Type": "text/html" });
      res.write(final);
      res.end();
    } else {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.write("Invalid channel!");
      res.end();
    }
  } catch (error) {
    console.log(error)
    res.writeHead(500, { "Content-Type": "text/html" });
    res.write("An error occurred! Please try again later.<br>");
    res.write(error.toString()); // Useful for debugging, remove in production
    res.end();
  }
}
