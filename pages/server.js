var fs = require('fs');
var HTMLMinifier = require('@bhavingajjar/html-minify');
var minifier = new HTMLMinifier();
var escape = require('escape-html');
var auth = require('../authentication.js');
const path = require('path')
const sharp = require("sharp")
const sanitizer = require("path-sanitizer")
const emojiRegex = require("./twemojiRegex").regex;
const { ChannelType, PermissionFlagsBits } = require('discord.js');

// Minify at runtime to save data on slow connections, but still allow editing the unminified file easily
// Is that a bad idea?

// Templates for viewing the channels in a server
const server_template = minifier.htmlMinify(fs.readFileSync('pages/templates/server.html', 'utf-8'));

const text_channel_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channellist/textchannel.html', 'utf-8'));
const category_channel_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channellist/categorychannel.html', 'utf-8'));

const server_icon_template = minifier.htmlMinify(fs.readFileSync('pages/templates/server/server_icon.html', 'utf-8'));

const invalid_server_template = minifier.htmlMinify(fs.readFileSync('pages/templates/server/invalid_server.html', 'utf-8'));
const no_images_warning_template = minifier.htmlMinify(fs.readFileSync('pages/templates/server/no_images_warning.html', 'utf-8'));

const cachedMembers = {}; // TODO: Find a better way

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || "");
};

// https://stackoverflow.com/questions/1967119/why-does-javascript-replace-only-first-instance-when-using-replace

const AsyncLock = require('async-lock');
const lock = new AsyncLock();

exports.processServer = async function (bot, req, res, args, discordID) {
  try {
    let serverList = "";
    const data = auth.dbQueryAll("SELECT * FROM servers WHERE discordID=?", [discordID]);

    await lock.acquire(discordID, async () => {
      for (let serverData of data) {
        const serverID = serverData.serverID;
        let server = bot.client.guilds.cache.get(serverID);

        if (server) {
          let member = cachedMembers[discordID]?.[server.id];
          if (!member) {
            try {
              member = await server.members.fetch(discordID);
              cachedMembers[discordID] = { ...cachedMembers[discordID], [server.id]: member };
            } catch (err) {
              // Delete from database if member isn't found
              auth.dbQueryRun("DELETE FROM servers WHERE serverID=? AND discordID=?", [server.id, discordID]);
              continue;
            }
          }

          // Construct server list HTML if the member is valid
          if (member && member.user) {
            const serverHTML = createServerHTML(server, member);
            serverList += serverHTML;
          }
        } else {
          auth.dbQueryRun("DELETE FROM servers WHERE serverID=?", [serverID]);
        }
      }
    });

    let response = server_template.replace("{$SERVER_LIST}", serverList);

    // Process specific server if `args[2]` is given
    if (args[2]) {
      const targetServer = bot.client.guilds.cache.get(args[2]);
      await lock.acquire(discordID, async () => {
        if (targetServer) {
          const member = await fetchAndCacheMember(targetServer, discordID);
          if (member) {
            response = processServerChannels(targetServer, member, response);
          } else {
            response = response.replace("{$CHANNEL_LIST}", invalid_server_template);
          }
        }
      });
    } else {
      response = response.replace("{$CHANNEL_LIST}", invalid_server_template);
    }

    // Handle theme and images preferences
    response = applyUserPreferences(response, req);

    res.writeHead(200, { "Content-Type": "text/html" });
    res.write(response);
    res.end();
  } catch (err) {
    console.error(err);
    res.writeHead(500);
    res.write("An error occurred. Please email larsenv293@gmail.com. Make sure to let us know where you had found the error");
    res.end();
  }
};

async function fetchAndCacheMember(server, discordID) {
  if (cachedMembers[discordID]?.[server.id]) {
    return cachedMembers[discordID][server.id];
  }
  try {
    const member = await server.members.fetch(discordID);
    cachedMembers[discordID] = { ...cachedMembers[discordID], [server.id]: member };
    return member;
  } catch {
    return null;
  }
}

function applyUserPreferences(response, req) {
  const whiteThemeCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('whiteThemeCookie='))?.split('=')[1];
  response = whiteThemeCookie == 1 ? response.replace("{$WHITE_THEME_ENABLED}", "class=\"light-theme\"") : response.replace("{$WHITE_THEME_ENABLED}", "");

  const imagesCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('images='))?.split('=')[1];
  response = imagesCookie == 1 ? response.replace("{$IMAGES_WARNING}", "") : response.replace("{$IMAGES_WARNING}", no_images_warning_template);

  return response;
}

function createServerHTML(server, member) {
  // Generate server-specific HTML
  let serverHTML = strReplace(server_icon_template, "{$SERVER_ICON_URL}", server.icon ? `/ico/server/${server.id}/${server.icon.startsWith("a_") ? server.icon.substring(2) : server.icon}.gif` : "/discord-mascot.gif");
  serverHTML = strReplace(serverHTML, "{$SERVER_URL}", "./" + server.id);
  serverHTML = strReplace(serverHTML, "{$SERVER_NAME}", `"${server.name}"`);
  return serverHTML;
}
