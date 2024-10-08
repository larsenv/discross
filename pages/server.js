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

exports.processServer = async function (bot, req, res, args, discordID) {
  try {
    //guestServers = [];
    //guestChannels = [];
    //var isGuest = false;
    /*if (typeof (discordID) == "object") {
      isGuest = true;
    }*/
    serverList = "";
    const data = /*typeof (discordID) == "object" ? guestServers.map(e => {
    return { serverID: e, discordID }
  }) :*/ auth.dbQueryAll("SELECT * FROM servers WHERE discordID=?", [discordID]);
    for (let server of data) {
      const id = server.serverID;
      server = bot.client.guilds.cache.get(id);
      if (server) {
        if (cachedMembers[discordID] && cachedMembers[discordID][server.id] !== undefined) {
          member = cachedMembers[discordID][server.id];
        } else if (!(/*isGuest && guestServers.includes(server.id)*/false)) {
          try {
            member = await server.members.fetch(discordID);
          } catch (err) {
            member = undefined;
            auth.dbQueryRun("DELETE FROM servers WHERE serverID=? AND discordID=?", [server.id, discordID]);
          }
          if (!cachedMembers[discordID]) {
            cachedMembers[discordID] = {};
          }
          cachedMembers[discordID][server.id] = member;
        }
        if (/*(isGuest && guestServers.includes(server.id)) ||*/ (member && member.user)) {
          if (server.icon) fs.promises.writeFile(path.resolve(`pages/static/ico/server`, sanitizer(`${server.serverID}/${server.icon.startsWith("a_") ? server.icon.substring(2) : server.icon}.gif`)), await (await fetch(`https://cdn.discordapp.com/icons/${server.serverID}/${server.icon.startsWith("a_") ? server.icon.substring(2) : server.icon}.gif?size=128`)).arrayBuffer());
          serverHTML = strReplace(server_icon_template, "{$SERVER_ICON_URL}", server.icon ? `/ico/server/${server.id}/${server.icon.startsWith("a_") ? server.icon.substring(2) : server.icon}.gif` : "/discord-mascot.gif");
          serverHTML = strReplace(serverHTML, "{$SERVER_URL}", "./" + server.id);
          serverHTML = strReplace(serverHTML, "{$SERVER_NAME}", '"' + server.name + '"');
          serverList += serverHTML;
        }
      } else {
        auth.dbQueryRun("DELETE FROM servers WHERE serverID=?", [id]);
      }
    }
    
    response = server_template.replace("{$SERVER_LIST}", serverList);

    let server = args[2] ? bot.client.guilds.cache.get(args[2]) : "-";
    try {
      if (server != "-") {
        if (!(/*isGuest && guestServers.includes(server?.id)*/false)) {
          member = await server?.members.fetch(discordID).catch(() => { });
          if ((!member) && (server)) {
            auth.dbQueryRun("DELETE FROM servers WHERE serverID=? AND discordID=?", [server.id, discordID]);
            throw new Error("They aren't on the server");
          } else if (member) {
            user = member.user;
            username = user.tag;
            if (member.displayName != user.username) {
              username = member.displayName + " (@" + user.tag + ")";
            }
            //} else {
            // username = "Guest";
            //}
            // username =
            if (!(/*(isGuest && guestServers.includes(server.id)) ||*/ member.user)) {
              server = undefined;
            }
          }

        }
      } else server = undefined;
    } catch (err) { // If they aren't in the server
      //console.log(err); //TODO: Only ignore TypeError: Cannot read property 'members' of undefined
      server = undefined; // Act like it doesn't exist
    }

    if (server) {
      categories = server.channels.cache.filter(channel => channel.type == ChannelType.GuildCategory);
      categoriesSorted = categories.sort((a, b) => (a.calculatedPosition - b.calculatedPosition));

      channelsSorted = [...server.channels.cache.filter(channel => channel.isTextBased() && !channel.parent).values()]; // Start with lone channels (no category)
      channelsSorted = channelsSorted.sort((a, b) => (a.calculatedPosition - b.calculatedPosition));


      categoriesSorted.forEach(function (category) {
        channelsSorted.push(category);
        channelsSorted = channelsSorted.concat(
          [...category.children.cache.sort((a, b) => (a.calculatedPosition - b.calculatedPosition))
            .values()]
            .filter(channel => channel.isTextBased())
        );
      });

      channelList = "";
      channelsSorted.forEach(function (item) {
        if (/*(isGuest && guestChannels.includes(item.id)) ||*/ (member.permissionsIn && member.permissionsIn(item).has(PermissionFlagsBits.ViewChannel, true))) {
          if (item.type == ChannelType.GuildCategory) {
            channelList += category_channel_template.replace("{$CHANNEL_NAME}", escape(item.name));
          } else {
            channelList += text_channel_template.replace("{$CHANNEL_NAME}", escape(item.name)).replace("{$CHANNEL_LINK}", "../channels/" + item.id + "#end");
          }
        }
      });
    } else {
      channelList = invalid_server_template;
    }

    response = response.replace("{$CHANNEL_LIST}", channelList);

    if (server) {
        response = response.replace("{$DISCORD_NAME}", '<font color="#999999" size="6" face="Arial, Helvetica, sans-serif">' + server.name + "</font><br>");
    } else {
        response = response.replace("{$DISCORD_NAME}", "");
    }

    const whiteThemeCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('whiteThemeCookie='))?.split('=')[1];
    whiteThemeCookie == 1 ? response = strReplace(response, "{$WHITE_THEME_ENABLED}", "class=\"light-theme\"") : response = strReplace(response, "{$WHITE_THEME_ENABLED}", "")
    const imagesCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('images='))?.split('=')[1];
    imagesCookie == 1 ? response = strReplace(response, "{$IMAGES_WARNING}", "") : response = strReplace(response, "{$IMAGES_WARNING}", no_images_warning_template)

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
        response = response.replace(match, `<img src="/resources/twemoji/${output}.gif" style="width: 6%;vertical-align:top;" alt="emoji">`)
      });
    }       
    
    const custom_emoji_matches = [...response.matchAll?.(/&lt;(:)?(?:(a):)?(\w{2,32}):(\d{17,19})?(?:(?!\1).)*&gt;?/g)];                // I'm not sure how to detect if an emoji is inline, since we don't have the whole message here to use it's length.
    if (custom_emoji_matches[0] && imagesCookie) custom_emoji_matches.forEach(async match => {                                                          // Tried Regex to find the whole message by matching the HTML tags that would appear before and after a message
      response = response.replace(match[0], `<img src="/imageProxy/emoji/${match[4]}.${match[2] ? "gif" : "png"}" style="width: 6%;"  alt="emoji">`)    // Make it smaller if inline
    })
    
    res.writeHead(200, { "Content-Type": "text/html" });
    res.write(response);
    res.end();
  } catch (err) {
    console.error(err);
    res.writeHead(500);
    res.write("An error occurred. Please email larsenv293@gmail.com. Make sure to let us know where you had found the error");
    res.end();
  }
}
