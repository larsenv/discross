var fs = require('fs');
var HTMLMinifier = require('@bhavingajjar/html-minify');
var minifier = new HTMLMinifier();
var escape = require('escape-html');
var auth = require('../authentication.js');
const path = require('path')
const sharp = require("sharp")
const sanitizer = require("path-sanitizer")
const { ChannelType, PermissionFlagsBits } = require('discord.js');

// Minify at runtime to save data on slow connections, but still allow editing the unminified file easily
// Is that a bad idea?

// Templates for viewing the channels in a server
const server_template = minifier.htmlMinify(fs.readFileSync('pages/templates/server.html', 'utf-8'));

const text_channel_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channellist/textchannel.html', 'utf-8'));
const category_channel_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channellist/categorychannel.html', 'utf-8'));

const server_icon_template = minifier.htmlMinify(fs.readFileSync('pages/templates/server/server_icon.html', 'utf-8'));

const invalid_server_template = minifier.htmlMinify(fs.readFileSync('pages/templates/server/invalid_server.html', 'utf-8'));

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
          fs.promises.writeFile(path.resolve(`pages/static/ico/server`, sanitizer(`${server.serverID}/${server.icon.startsWith("a_") ? server.icon.substring(2) : server.icon}.gif`)), await (await fetch(`https://cdn.discordapp.com/icons/${server.serverID}/${server.icon.startsWith("a_") ? server.icon.substring(2) : server.icon}.gif?size=128`)).arrayBuffer());
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

    res.writeHead(200, { "Content-Type": "text/html" });
    res.write(response);
    res.end();
  } catch (err) {
    console.error(err);
    res.writeHead(500);
    res.write("An unexpected error ocurred! Please contact Discross staff.");
    res.end();
  }
}