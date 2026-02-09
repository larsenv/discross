var fs = require('fs');
var escape = require('escape-html');
var he = require('he'); // Encodes HTML attributes
const path = require('path');
const sharp = require("sharp");
const emojiRegex = require("./twemojiRegex").regex;
const sanitizer = require("path-sanitizer").default;
const { PermissionFlagsBits } = require('discord.js');
const { channel } = require('diagnostics_channel');
const fetch = require("sync-fetch");
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
  try {
    // Check if bot is connected
    const clientIsReady = bot && bot.client && (typeof bot.client.isReady === 'function' ? bot.client.isReady() : !!bot.client.uptime);
    
    if (!clientIsReady) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.write("The bot isn't connected, try again in a moment");
      res.end();
      return;
    }

    // 1. Setup Variables
    let response = "";
    let chnl;
    let botMember;
    let member;
    let user;
    let template;
    let final;

    // 2. Fetch Channel & Member Data
    try {
      chnl = await bot.client.channels.fetch(args[2]);
    } catch (err) {
      chnl = undefined;
    }

    if (chnl) {
      botMember = await chnl.guild.members.fetch(bot.client.user.id);
      member = await chnl.guild.members.fetch(discordID);
      
      // 3. Security: Check View Permissions
      if (!member.permissionsIn(chnl).has(PermissionFlagsBits.ViewChannel, true) || 
          !botMember.permissionsIn(chnl).has(PermissionFlagsBits.ViewChannel, true)) {
        res.write("You (or the bot) don't have permission to do that!");
        res.end();
        return;
      }

      // 4. Load & Prepare the Drawing Template
      // We load the "channel_template" which is your 'draw.html'
      template = strReplace(channel_template, "{$SERVER_ID}", chnl.guild.id);
      template = strReplace(template, "{$CHANNEL_ID}", chnl.id);
      template = strReplace(template, "{$CHANNEL_NAME}", chnl.name);
      
      // 5. Theme Logic (Cookie Check)
      const whiteThemeCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('whiteThemeCookie='))?.split('=')[1];
      if (whiteThemeCookie == 1) {
        template = strReplace(template, "{$WHITE_THEME_ENABLED}", "class=\"light-theme\"");
      } else if (whiteThemeCookie == 2) {
        template = strReplace(template, "{$WHITE_THEME_ENABLED}", "class=\"amoled-theme\"");
      } else {
        template = strReplace(template, "{$WHITE_THEME_ENABLED}", "");
      }

      // 6. Security: Check Send Permissions (Optional but good for UX)
      // Even though we aren't displaying messages, we can check if they are allowed to send drawings.
      // If your HTML has the form hardcoded, this block mostly just validates the bot's permissions.
      if (!botMember.permissionsIn(chnl).has(PermissionFlagsBits.ManageWebhooks, true)) {
         // Optionally handle error or disable form here if you were injecting it
         // For now, we just pass through since your HTML handles the form
      }

      // 7. Send the Response
      res.writeHead(200, { "Content-Type": "text/html" });
      res.write(template); 
      res.end();

    } else {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.write("Invalid channel!");
      res.end();
    }
  } catch (error) {
    console.log(error);
    res.writeHead(500, { "Content-Type": "text/html" });
    res.write("An error occurred! Please try again later.<br>");
    res.end();
  }
};
