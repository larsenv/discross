var fs = require('fs');
var HTMLMinifier = require('@bhavingajjar/html-minify');
var minifier = new HTMLMinifier();
var escape = require('escape-html');
var UAParser = require('ua-parser-js');
var auth = require('../authentication.js');
const path = require('path')
const sharp = require("sharp")
const sanitizer = require("path-sanitizer").default;
const emojiRegex = require("./twemojiRegex").regex;
const { ChannelType, PermissionFlagsBits } = require('discord.js');

// Minify at runtime to save data on slow connections, but still allow editing the unminified file easily
// Is that a bad idea?

// Templates for viewing the channels in a server
const server_template = minifier.htmlMinify(fs.readFileSync('pages/templates/server.html', 'utf-8'));

const text_channel_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channellist/textchannel.html', 'utf-8'));
const announcement_channel_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channellist/announcementchannel.html', 'utf-8'));
const category_channel_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channellist/categorychannel.html', 'utf-8'));
const voice_channel_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channellist/voicechannel.html', 'utf-8'));
const thread_channel_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channellist/threadchannel.html', 'utf-8'));
const forum_channel_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channellist/forumchannel.html', 'utf-8'));
const locked_channel_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channellist/lockedchannel.html', 'utf-8'));
const rules_channel_template = minifier.htmlMinify(fs.readFileSync('pages/templates/channellist/ruleschannel.html', 'utf-8'));

const server_icon_template = minifier.htmlMinify(fs.readFileSync('pages/templates/server/server_icon.html', 'utf-8'));

const server_list_only_template = minifier.htmlMinify(fs.readFileSync('pages/templates/server/server_list_only.html', 'utf-8'));
const sync_warning_template = minifier.htmlMinify(fs.readFileSync('pages/templates/server/sync_warning.html', 'utf-8'));
const no_images_warning_template = minifier.htmlMinify(fs.readFileSync('pages/templates/server/no_images_warning.html', 'utf-8'));
const images_enabled_template = minifier.htmlMinify(fs.readFileSync('pages/templates/server/images_enabled.html', 'utf-8'));

const cachedMembers = {}; // TODO: Find a better way

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || "");
};

`
i think str.replaceAll is a better option than str.split().join() because it's more readable and easier to understand
but this also works
so imma leave it as is :)
`

// https://stackoverflow.com/questions/1967119/why-does-javascript-replace-only-first-instance-when-using-replace

const AsyncLock = require('async-lock');
const lock = new AsyncLock();

function processServerChannels(server, member, response) {
  try {
    const categories = server.channels.cache.filter(channel => channel.type == ChannelType.GuildCategory);
    const categoriesSorted = categories.sort((a, b) => a.position - b.position);

    // Start with lone text channels (no category) and voice channels
    let channelsSorted = [...server.channels.cache.filter(channel => (channel.isTextBased() || channel.type == ChannelType.GuildVoice) && !channel.parent).values()];
    channelsSorted = channelsSorted.sort((a, b) => a.position - b.position);

    categoriesSorted.forEach(category => {
      channelsSorted.push(category);
      channelsSorted = channelsSorted.concat(
        [...category.children.cache.sort((a, b) => a.position - b.position)
          .values()]
          .filter(channel => channel.isTextBased() || channel.type == ChannelType.GuildVoice)
      );
    });

    // Add threads from voice channels (voice channel threads)
    // Threads are in the guild's channels cache with parentId pointing to voice channels
    const allThreads = server.channels.cache.filter(channel => 
      channel.type == ChannelType.PublicThread || channel.type == ChannelType.PrivateThread
    );
    
    // Group threads by their parent voice channel for efficient insertion
    const threadsByParent = new Map();
    allThreads.forEach(thread => {
      if (thread.parentId) {
        const parent = server.channels.cache.get(thread.parentId);
        // Only collect threads whose parent is a voice channel
        if (parent && parent.type == ChannelType.GuildVoice) {
          if (!threadsByParent.has(thread.parentId)) {
            threadsByParent.set(thread.parentId, []);
          }
          threadsByParent.get(thread.parentId).push(thread);
        }
      }
    });
    
    // Insert threads after their parent voice channels in reverse order to maintain positions
    for (let i = channelsSorted.length - 1; i >= 0; i--) {
      const channel = channelsSorted[i];
      if (channel.type == ChannelType.GuildVoice && threadsByParent.has(channel.id)) {
        const threads = threadsByParent.get(channel.id).sort((a, b) => a.position - b.position);
        channelsSorted.splice(i + 1, 0, ...threads);
      }
    }


    let channelList = "";
    let currentCategoryId = null;
    
    channelsSorted.forEach((item, index) => {
      // Check if the member has permission to view the channel
      if (member.permissionsIn(item).has(PermissionFlagsBits.ViewChannel, true)) {
        if (item.type == ChannelType.GuildCategory) {
          // Close previous category if exists
          if (currentCategoryId !== null) {
            channelList += '</div>'; // Close previous category-channels div
          }
          currentCategoryId = item.id;
          channelList += category_channel_template
            .replace("{$CHANNEL_NAME}", escape(item.name))
            .replace("{$CATEGORY_ID}", item.id);
        } else if (item.type == ChannelType.GuildForum) {
          // Forum channels (#16)
          channelList += forum_channel_template.replace("{$CHANNEL_NAME}", escape(item.name)).replace("{$CHANNEL_LINK}", `../channels/${item.id}`);
        } else if (item.type == ChannelType.GuildAnnouncement || item.type == ChannelType.GuildNews) {
          // Use announcement template for announcement/news channels
          channelList += announcement_channel_template.replace("{$CHANNEL_NAME}", escape(item.name)).replace("{$CHANNEL_LINK}", `../channels/${item.id}`);
        } else if (item.type == ChannelType.GuildVoice) {
          // Voice channels - check if they're locked (#27)
          const canSendMessages = member.permissionsIn(item).has(PermissionFlagsBits.SendMessages, true);
          if (!canSendMessages) {
            // Locked voice channel
            channelList += locked_channel_template.replace("{$CHANNEL_NAME}", escape(item.name)).replace("{$CHANNEL_LINK}", `../channels/${item.id}`);
          } else {
            channelList += voice_channel_template.replace("{$CHANNEL_NAME}", escape(item.name));
          }
        } else if (item.type == ChannelType.PublicThread || item.type == ChannelType.PrivateThread) {
          channelList += thread_channel_template.replace("{$CHANNEL_NAME}", escape(item.name)).replace("{$CHANNEL_LINK}", `../channels/${item.id}`);
        } else if (item.type == ChannelType.GuildStageVoice) {
          // Stage channels
          channelList += voice_channel_template.replace("{$CHANNEL_NAME}", escape(item.name));
        } else if (item.isTextBased()) {
          // Text-based channels - check if locked or if it's a rules channel
          const canSendMessages = member.permissionsIn(item).has(PermissionFlagsBits.SendMessages, true);
          
          // Check if this is a rules channel by name
          const isRulesChannel = item.name.toLowerCase().includes('rule');
          
          if (isRulesChannel) {
            channelList += rules_channel_template.replace("{$CHANNEL_NAME}", escape(item.name)).replace("{$CHANNEL_LINK}", `../channels/${item.id}`);
          } else if (!canSendMessages) {
            // Locked channel (#12)
            channelList += locked_channel_template.replace("{$CHANNEL_NAME}", escape(item.name)).replace("{$CHANNEL_LINK}", `../channels/${item.id}`);
          } else {
            // Regular text channel
            channelList += text_channel_template
              .replace("{$CHANNEL_NAME}", escape(item.name))
              .replace("{$CHANNEL_LINK}", `../channels/${item.id}`);
        }
      }
    });
    
    // Close the last category if exists
    if (currentCategoryId !== null) {
      channelList += '</div>';
    }


    // Replace the channel list in the response
    response = response.replace("{$CHANNEL_LIST}", channelList);
  } catch (err) {
    console.error("Error processing server channels:", err);
    response = response.replace("{$CHANNEL_LIST}", sync_warning_template);
  }

  return response;
}

exports.processServer = async function (bot, req, res, args, discordID) {
  try {
    let serverList = "";
    let serversDeleted = 0; // Track if servers were deleted due to sync issues
    const clientIsReady = bot && bot.client && (typeof bot.client.isReady === 'function' ? bot.client.isReady() : !!bot.client.uptime);

    // Acquire lock for this user to prevent race conditions where users might see other users' servers
    await lock.acquire(discordID, async () => {
      const data = auth.dbQueryAll("SELECT * FROM servers WHERE discordID=?", [discordID]);
      
      for (let serverData of data) {
        const serverID = serverData.serverID;
        let server = bot.client.guilds.cache.get(serverID);

        if (server) {
          let member = cachedMembers[discordID]?.[server.id];
          if (clientIsReady && !member) {
            try {
              member = await server.members.fetch(discordID);
              cachedMembers[discordID] = { ...cachedMembers[discordID], [server.id]: member };
            } catch (err) {
              // Delete from database if member isn't found
              auth.dbQueryRun("DELETE FROM servers WHERE serverID=? AND discordID=?", [server.id, discordID]);
              serversDeleted++;
              continue;
            }
          }

          // Construct server list HTML if the member is valid
          if (member && member.user) {
            const serverHTML = createServerHTML(server, member);
            serverList += serverHTML;
          }
        } else {
          // NEW: Only delete the server from the DB if the bot client is ready.
          // If the bot hasn't connected yet (client not ready), skip deletion so servers are preserved during boot.
          const clientIsReady = bot && bot.client && (typeof bot.client.isReady === 'function' ? bot.client.isReady() : !!bot.client.uptime);

          if (clientIsReady) {
            // bot is connected and the guild truly isn't in cache -> safe to delete
            auth.dbQueryRun("DELETE FROM servers WHERE serverID=?", [serverID]);
            serversDeleted++;
          } else {
            // bot not ready / not connected: do not delete the server row; treat as temporarily missing
            // keep server in DB and do not increment serversDeleted
            console.log(`Skipping deletion of server ${serverID} because bot client is not ready.`);
            continue;
          }
        }
      }
    });

    let response = server_template.replace("{$SERVER_LIST}", serverList);

    // Check for sync_needed parameter
    const url = require('url');
    const parsedUrl = url.parse(req.url, true);
    const syncNeeded = parsedUrl.query.sync_needed;

    // Process specific server if `args[2]` is given
    if (args[2]) {
      const targetServer = bot.client.guilds.cache.get(args[2]);
      await lock.acquire(discordID, async () => {
        if (targetServer) {
          response = response.replace("{$DISCORD_NAME}", '<font color="#999999" size="6" face="Arial, Helvetica, sans-serif">' + targetServer.name + "</font><br>");
          const member = await fetchAndCacheMember(targetServer, discordID);
          if (member) {
            response = processServerChannels(targetServer, member, response);
          } else {
            response = response.replace("{$CHANNEL_LIST}", sync_warning_template);
          }
        } else {
          response = response.replace("{$DISCORD_NAME}", "");
        }
      });
    } else {
      // If no specific server is selected, choose template based on whether user has servers
      if (serverList.trim() === "") {
        // No servers available, show full authentication banner
        response = response.replace("{$CHANNEL_LIST}", sync_warning_template);
      } else if (syncNeeded === 'true' || serversDeleted > 0) {
        // Show sync warning if explicitly requested or servers were deleted due to sync issues
        response = response.replace("{$CHANNEL_LIST}", sync_warning_template);
      } else {
        // User has servers and they seem synced, show simple server selection
        response = response.replace("{$CHANNEL_LIST}", server_list_only_template);
      }
      response = response.replace("{$DISCORD_NAME}", "");
    }

    const imagesCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('images='))?.split('=')[1];

    // Handle theme and images preferences
    response = applyUserPreferences(response, req);

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
    
    // Parse and add user agent display
    response = addUserAgentDisplay(response, req);
    
    res.writeHead(200, { "Content-Type": "text/html" });
    res.write(response);
    res.end();
  } catch (err) {
    console.error(err);
    res.writeHead(500);
    res.write("An error occurred. Please email admin@discross.net or contact us on our Discord server. Make sure to let us know where you had found the error");
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

  // Apply theme class based on cookie value: 0=dark (default), 1=light, 2=amoled
  if (whiteThemeCookie == 1) {
    response = response.replace("{$WHITE_THEME_ENABLED}", "class=\"light-theme\"");
  } else if (whiteThemeCookie == 2) {
    response = response.replace("{$WHITE_THEME_ENABLED}", "class=\"amoled-theme\"");
  } else {
    response = response.replace("{$WHITE_THEME_ENABLED}", "");
  }

  const imagesCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('images='))?.split('=')[1];
  response = imagesCookie == 1 ? response.replace("{$IMAGES_WARNING}", images_enabled_template) : response.replace("{$IMAGES_WARNING}", no_images_warning_template);

  return response;
}

function createServerHTML(server, member) {
  // Generate server-specific HTML
  let serverHTML = strReplace(server_icon_template, "{$SERVER_ICON_URL}", server.icon ? `/ico/server/${server.id}/${server.icon.startsWith("a_") ? server.icon.substring(2) : server.icon}.gif` : "/discord-mascot.gif");
  serverHTML = strReplace(serverHTML, "{$SERVER_URL}", "./" + server.id);
  serverHTML = strReplace(serverHTML, "{$SERVER_NAME}", server.name);
  return serverHTML;
}

function addUserAgentDisplay(response, req) {
  // Parse user agent
  const userAgent = req.headers['user-agent'] || '';
  const parser = new UAParser(userAgent);
  const uaResult = parser.getResult();
  
  // Create user agent display string
  let userAgentDisplay = '';
  if (uaResult.browser.name || uaResult.os.name) {
    const browserName = escape(uaResult.browser.name || '');
    const browserVersion = escape(uaResult.browser.version || '');
    const osName = escape(uaResult.os.name || '');
    const osVersion = escape(uaResult.os.version || '');
    const deviceVendor = escape(uaResult.device.vendor || '');
    const deviceModel = escape(uaResult.device.model || '');
    
    const browserInfo = browserName ? `${browserName}${browserVersion ? ' ' + browserVersion : ''}` : '';
    const osInfo = osName ? `${osName}${osVersion ? ' ' + osVersion : ''}` : '';
    const deviceInfo = deviceVendor || deviceModel ? ` (${[deviceVendor, deviceModel].filter(Boolean).join(' ')})` : '';
    
    // Build display text based on what information is available
    if (browserInfo && osInfo) {
      const displayText = `Platform: ${browserInfo} on ${osInfo}${deviceInfo}`;
      userAgentDisplay = `<font color="#aaaaaa" size="2">${displayText}</font>`;
    } else if (browserInfo) {
      const displayText = `Platform: ${browserInfo}${deviceInfo}`;
      userAgentDisplay = `<font color="#aaaaaa" size="2">${displayText}</font>`;
    } else if (osInfo) {
      const displayText = `Platform: ${osInfo}${deviceInfo}`;
      userAgentDisplay = `<font color="#aaaaaa" size="2">${displayText}</font>`;
    }
    // If neither browserInfo nor osInfo, userAgentDisplay remains empty
  }
  
  // Add user agent display to response using strReplace for consistency
  response = strReplace(response, "{$USER_AGENT}", userAgentDisplay);
  
  return response;
}
