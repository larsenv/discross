'use strict';
const fs = require('fs');
const path = require('path');
const { SnowTransfer } = require('snowtransfer');
const sharp = require('sharp');
const sanitizer = require('path-sanitizer').default;
const escape = require('escape-html');
const UAParser = require('ua-parser-js');
const auth = require('../src/authentication.js');
const emojiRegex = require('./twemojiRegex').regex;
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const { unicodeToTwemojiCode } = require('./emojiUtils');
const {
    renderTemplate,
    render,
    isBotReady,
    getPageThemeAttr,
    buildSessionParam,
    parseCookies,
    loadAndRenderPageTemplate,
    getTemplate,
} = require('./utils.js');

// Templates for viewing the channels in a server
const server_template = loadAndRenderPageTemplate('server');

const text_channel_template = getTemplate('text-channel', 'channellist');
const announcement_channel_template = getTemplate('announcement-channel', 'channellist');
const category_channel_template = getTemplate('category-channel', 'channellist');
const voice_channel_template = getTemplate('voice-channel', 'channellist');
const thread_channel_template = getTemplate('thread-channel', 'channellist');
const thread_group_header_template = getTemplate('thread-group-header', 'channellist');
const forum_channel_template = getTemplate('forum-channel', 'channellist');
const locked_channel_template = getTemplate('locked-channel', 'channellist');
const rules_channel_template = getTemplate('rules-channel', 'channellist');

const server_icon_template = getTemplate('server-icon', 'server');

const server_list_only_template = getTemplate('server-list-only', 'server');
const sync_warning_template = getTemplate('sync-warning', 'server');
const no_images_warning_template = getTemplate('no-images-warning', 'server');
const images_enabled_template = getTemplate('images-enabled', 'server');

const logged_in_template = getTemplate('logged-in', 'index');

const cachedMembers = {}; // TODO: Find a better way
const MAX_CACHED_MEMBERS = 250; // evict oldest user's data when the cap is hit

function evictOldestCachedMember() {
    const keys = Object.keys(cachedMembers);
    if (keys.length >= MAX_CACHED_MEMBERS) {
        delete cachedMembers[keys[0]];
    }
}

const AsyncLock = require('async-lock');
const lock = new AsyncLock();

async function processServerChannels(server, member, response, sessionParam) {
    try {
        const discordID = member.id;

        // Fetch active threads for this server
        const activeThreadsList = await server.channels
            .fetchActiveThreads()
            .then((r) => [...r.threads.values()])
            .catch((err) => {
                console.error('Failed to fetch active threads:', err);
                return [];
            });

        // For each active thread, check if this specific user is a member.
        // fetchActiveThreads() only populates the bot's own membership in the cache,
        // so we must call thread.members.fetch(userId) per thread to check the real user.
        // We do all checks in parallel to minimise latency.
        const userThreadIds = new Set();
        if (activeThreadsList.length > 0) {
            await Promise.allSettled(
                activeThreadsList.map(async (thread) => {
                    try {
                        await thread.members.fetch(discordID);
                        userThreadIds.add(thread.id);
                    } catch {
                        // user is not a member of this thread — skip it
                    }
                })
            );
        }

        // Build threadsByParent using only threads the user is in
        const threadsByParent = new Map();
        activeThreadsList.forEach((thread) => {
            if (!thread.parentId) return;
            if (!userThreadIds.has(thread.id)) return;
            if (!threadsByParent.has(thread.parentId)) {
                threadsByParent.set(thread.parentId, []);
            }
            threadsByParent.get(thread.parentId).push(thread);
        });

        const categories = server.channels.cache.filter(
            (channel) => channel.type === ChannelType.GuildCategory
        );
        const categoriesSorted = categories.sort((a, b) => a.position - b.position);

        // Helper: check if a channel should be shown in the channel list
        const isDisplayableChannel = (channel) =>
            channel.isTextBased() ||
            channel.type === ChannelType.GuildVoice ||
            channel.type === ChannelType.GuildForum ||
            channel.type === ChannelType.GuildMedia;

        // Start with lone text channels (no category), voice channels, and forum/media channels
        const channelsSorted = [
            ...server.channels.cache
                .filter((channel) => isDisplayableChannel(channel) && !channel.parent)
                .values(),
        ].sort((a, b) => a.position - b.position);

        categoriesSorted.forEach((category) => {
            channelsSorted.push(
                category,
                ...[
                    ...category.children.cache.sort((a, b) => a.position - b.position).values(),
                ].filter(isDisplayableChannel)
            );
        });

        let channelList = '';
        let currentCategoryId = null;

        channelsSorted.forEach((item, index) => {
            const isThread =
                item.type === ChannelType.PublicThread || item.type === ChannelType.PrivateThread;
            // Check if the member has permission to view the channel
            if (member.permissionsIn(item).has(PermissionFlagsBits.ViewChannel, true)) {
                const escapedName = escape(normalizeWeirdUnicode(item.name));
                if (item.type === ChannelType.GuildCategory) {
                    // Close previous category if exists
                    if (currentCategoryId !== null) {
                        channelList += getTemplate('div-close', 'misc'); // Close previous category-channels div
                    }
                    currentCategoryId = item.id;
                    channelList += render('channellist/category-channel', {
                        CHANNEL_NAME: escapedName,
                        CATEGORY_ID: item.id,
                    });
                } else if (
                    item.type === ChannelType.GuildForum ||
                    item.type === ChannelType.GuildMedia
                ) {
                    const iconUrl =
                        item.type === ChannelType.GuildForum
                            ? '/resources/twemoji/1f4ac.gif'
                            : '/resources/twemoji/1f39e.gif';
                    channelList += render('channellist/forum-channel', {
                        CHANNEL_NAME: escapedName,
                        ICON_URL: iconUrl,
                    });
                } else if (
                    item.type === ChannelType.GuildAnnouncement ||
                    item.type === ChannelType.GuildNews
                ) {
                    channelList += render('channellist/announcement-channel', {
                        CHANNEL_NAME: escapedName,
                        CHANNEL_LINK: `../channels/${item.id}${sessionParam}`,
                    });
                } else if (item.type === ChannelType.GuildVoice) {
                    const canSendMessages = member
                        .permissionsIn(item)
                        .has(PermissionFlagsBits.SendMessages, true);
                    if (!canSendMessages) {
                        channelList += render('channellist/locked-channel', {
                            CHANNEL_NAME: escapedName,
                            CHANNEL_LINK: `../channels/${item.id}${sessionParam}`,
                        });
                    } else {
                        channelList += render('channellist/voice-channel', {
                            CHANNEL_NAME: escapedName,
                            CHANNEL_LINK: `../channels/${item.id}${sessionParam}`,
                        });
                    }
                } else if (item.type === ChannelType.GuildStageVoice) {
                    channelList += render('channellist/voice-channel', {
                        CHANNEL_NAME: escapedName,
                        CHANNEL_LINK: `../channels/${item.id}${sessionParam}`,
                    });
                } else if (!isThread && item.isTextBased()) {
                    const canSendMessages = member
                        .permissionsIn(item)
                        .has(PermissionFlagsBits.SendMessages, true);

                    const isRulesChannel = item.name.toLowerCase().includes('rule');

                    if (isRulesChannel) {
                        channelList += render('channellist/rules-channel', {
                            CHANNEL_NAME: escapedName,
                            CHANNEL_LINK: `../channels/${item.id}${sessionParam}`,
                        });
                    } else if (!canSendMessages) {
                        channelList += render('channellist/locked-channel', {
                            CHANNEL_NAME: escapedName,
                            CHANNEL_LINK: `../channels/${item.id}${sessionParam}`,
                        });
                    } else {
                        channelList += render('channellist/text-channel', {
                            CHANNEL_NAME: escapedName,
                            CHANNEL_LINK: `../channels/${item.id}${sessionParam}`,
                        });
                    }
                }

                // After rendering each non-category channel, add its collapsible thread group if it has threads
                if (item.type !== ChannelType.GuildCategory && threadsByParent.has(item.id)) {
                    const channelThreads = threadsByParent
                        .get(item.id)
                        .sort(
                            (a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0)
                        );
                    if (channelThreads.length > 0) {
                        channelList += render('channellist/thread-group-header', {
                            CHANNEL_ID: item.id,
                        });
                        channelThreads.forEach((thread) => {
                            const threadEscapedName = escape(normalizeWeirdUnicode(thread.name));
                            channelList += render('channellist/thread-channel', {
                                CHANNEL_NAME: threadEscapedName,
                                CHANNEL_LINK: `../channels/${thread.id}${sessionParam}`,
                            });
                        });
                        channelList += getTemplate('div-close', 'misc');
                    }
                }
            }
        });

        // Close the last category if exists
        if (currentCategoryId !== null) {
            channelList += getTemplate('div-close', 'misc');
        }

        // Replace the channel list in the response
        response = renderTemplate(response, { CHANNEL_LIST: channelList });
    } catch (err) {
        console.error('Error processing server channels:', err);
        response = renderTemplate(response, { CHANNEL_LIST: server_list_only_template });
    }

    return response;
}

exports.processServer = async function (bot, req, res, args, discordID) {
    try {
        let serverList = '';
        let serversDeleted = 0; // Track if servers were deleted due to sync issues
        const clientIsReady = isBotReady(bot);

        if (!clientIsReady) {
            res.writeHead(503, { 'Content-Type': 'text/html' });
            res.end(getTemplate('bot-not-connected', 'misc'));
            return;
        }

        const parsedUrl = new URL(req.url, 'http://localhost');
        const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
        const urlTheme = parsedUrl.searchParams.get('theme');
        const urlImages = parsedUrl.searchParams.get('images');

        // Read cookies up front to decide whether URL params need to be propagated
        const { whiteThemeCookie: whiteThemeCookieForParam, images: imagesCookieForParam } =
            parseCookies(req);

        // Build combined URL params for links — only include preference params when the
        // corresponding cookie is absent (i.e. the browser doesn't support cookies)
        const sessionParam = buildSessionParam(
            urlSessionID,
            urlTheme,
            whiteThemeCookieForParam,
            urlImages,
            imagesCookieForParam
        );

        // Acquire lock for this user to prevent race conditions where users might see other users' servers
        await lock.acquire(discordID, async () => {
            // Trigger background refresh if we're on the main server list and bot is ready
            if (!args[2] && clientIsReady) {
                // We don't await this to keep the page load fast
                refreshDiscordServers(bot, discordID).catch(console.error);
            }

            const data = auth.dbQueryAll('SELECT * FROM servers WHERE discordID=?', [discordID]);

            for (const serverData of data) {
                const serverID = serverData.serverID;
                const server = bot.client.guilds.cache.get(serverID);

                if (server) {
                    let member = cachedMembers[discordID]?.[server.id];
                    if (clientIsReady && !member) {
                        try {
                            member = await server.members.fetch(discordID);
                            if (!cachedMembers[discordID]) evictOldestCachedMember();
                            cachedMembers[discordID] = {
                                ...cachedMembers[discordID],
                                [server.id]: member,
                            };
                        } catch (err) {
                            // Delete from database if member isn't found
                            auth.dbQueryRun(
                                'DELETE FROM servers WHERE serverID=? AND discordID=?',
                                [server.id, discordID]
                            );
                            serversDeleted++;
                            continue;
                        }
                    }

                    // Construct server list HTML if the member is valid
                    if (member && member.user) {
                        const imagesCookie =
                            urlImages !== null
                                ? parseInt(urlImages, 10)
                                : imagesCookieForParam !== undefined
                                  ? parseInt(imagesCookieForParam, 10)
                                  : 1;
                        const serverHTML = createServerHTML(
                            server,
                            member,
                            imagesCookie,
                            sessionParam
                        );
                        serverList += serverHTML;
                    }
                } else {
                    // Only delete the server from the DB if the bot client is ready.
                    // If the bot hasn't connected yet, skip deletion so servers are preserved during boot.
                    if (clientIsReady) {
                        // bot is connected and the guild truly isn't in cache -> safe to delete
                        auth.dbQueryRun('DELETE FROM servers WHERE serverID=?', [serverID]);
                        serversDeleted++;
                    } else {
                        // bot not ready / not connected: do not delete the server row; treat as temporarily missing
                        console.warn(
                            `Skipping deletion of server ${serverID} because bot client is not ready.`
                        );
                        continue;
                    }
                }
            }
        });

        const username = await auth.getUsername(discordID);

        let response = server_template;
        const templateData = {
            SERVER_LIST: serverList,
            USER_ID: discordID,
            USER_NAME: escape(username),
        };

        // syncNeeded already parsed via parsedUrl above
        const syncNeeded = parsedUrl.searchParams.get('sync_needed');

        if (args[2]) {
            const targetServer = bot.client.guilds.cache.get(args[2]);
            await lock.acquire(discordID, async () => {
                if (targetServer) {
                    response = renderTemplate(response, {
                        DISCORD_NAME: render('server/partials/server-name-header', {
                            NAME: escape(normalizeWeirdUnicode(targetServer.name)),
                        }),
                    });
                    const member = await fetchAndCacheMember(targetServer, discordID);
                    if (member) {
                        response = await processServerChannels(
                            targetServer,
                            member,
                            response,
                            sessionParam
                        );
                    } else {
                        response = renderTemplate(response, {
                            CHANNEL_LIST: server_list_only_template,
                        });
                    }
                } else {
                    response = renderTemplate(response, { DISCORD_NAME: '' });
                    response = renderTemplate(response, { CHANNEL_LIST: 'Invalid channel!' });
                }
            });
        } else {
            // If no specific server is selected, choose template based on whether user has servers
            if (serverList.trim() === '') {
                response = renderTemplate(response, { CHANNEL_LIST: sync_warning_template });
            } else if (syncNeeded === 'true' || serversDeleted > 0) {
                response = renderTemplate(response, { CHANNEL_LIST: server_list_only_template });
            } else {
                response = renderTemplate(response, { CHANNEL_LIST: server_list_only_template });
            }
            response = renderTemplate(response, { DISCORD_NAME: '' });
        }

        // Render remaining placeholders including USER_ID and USER_NAME
        response = renderTemplate(response, templateData);

        const imagesCookie =
            urlImages !== null
                ? parseInt(urlImages, 10)
                : imagesCookieForParam !== undefined
                  ? parseInt(imagesCookieForParam, 10)
                  : 1;

        // Handle theme and images preferences
        response = applyUserPreferences(response, req);

        if (response.match?.(emojiRegex) && imagesCookie === 1) {
            const matches = response.match(emojiRegex);
            if (matches) {
                [...matches].forEach((match) => {
                    const output = unicodeToTwemojiCode(match);
                    response = response.replaceAll(
                        match,
                        render('server/partials/server-emoji-twemoji', {
                            CODE: output,
                        })
                    );
                });
            }
        }

        const custom_emoji_matches = response.matchAll
            ? [...response.matchAll(/&lt;(:)?(?:(a):)?(\w{2,32}):(\d{16,20})?(?:(?!\1).)*&gt;/g)]
            : [];
        if (custom_emoji_matches.length > 0 && imagesCookie === 1)
            custom_emoji_matches.forEach((match) => {
                response = response.replaceAll(
                    match[0],
                    render('server/partials/server-emoji-custom', {
                        EMOJI_ID: match[4],
                        EXT: match[2] ? 'gif' : 'png',
                    })
                );
            });

        // Parse and add user agent display
        response = addUserAgentDisplay(response, req);

        // Inject URL parameters into template links
        response = response.split('{$SESSION_PARAM}').join(sessionParam);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(response);
    } catch (err) {
        console.error(err);
        res.writeHead(500);
        res.end(
            'An error occurred. Please email admin@discross.net or contact us on our Discord server. Make sure to let us know where you had found the error'
        );
    }
};

async function fetchAndCacheMember(server, discordID) {
    if (cachedMembers[discordID]?.[server.id]) {
        return cachedMembers[discordID][server.id];
    }
    try {
        const member = await server.members.fetch(discordID);
        if (!cachedMembers[discordID]) evictOldestCachedMember();
        cachedMembers[discordID] = { ...cachedMembers[discordID], [server.id]: member };
        return member;
    } catch {
        return null;
    }
}

function applyUserPreferences(response, req) {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const urlImages = parsedUrl.searchParams.get('images');
    const { images: imagesCookie } = parseCookies(req);
    const imagesEnabled =
        urlImages !== null ? urlImages === '1' : imagesCookie === '1' || imagesCookie === undefined; // Default to enabled (1) if not set

    return renderTemplate(response, {
        WHITE_THEME_ENABLED: getPageThemeAttr(req),
        IMAGES_WARNING: imagesEnabled ? images_enabled_template : no_images_warning_template,
    });
}

function createServerHTML(server, member, imagesCookie, sessionParam) {
    const serverName = server.name
        .replace(/<a?:[^:]+:\d+>/g, '')
        .replace(emojiRegex, '')
        .trim();

    const iconUrl = server.icon
        ? `/ico/server/${server.id}/${server.icon.startsWith('a_') ? server.icon.substring(2) : server.icon}.gif`
        : '/discord-mascot.gif';

    return render('server/server-icon', {
        SERVER_ICON_URL: iconUrl,
        SERVER_URL: './' + server.id + (sessionParam || ''),
        SERVER_NAME: escape(normalizeWeirdUnicode(serverName)),
    });
}

function addUserAgentDisplay(response, req) {
    const userAgent = req.headers['user-agent'] || '';
    const parser = new UAParser(userAgent);
    const uaResult = parser.getResult();

    const browserName = escape(uaResult.browser.name || '');
    const browserVersion = escape(uaResult.browser.version || '');
    const osName = escape(uaResult.os.name || '');
    const osVersion = escape(uaResult.os.version || '');
    const deviceVendor = escape(uaResult.device.vendor || '');
    const deviceModel = escape(uaResult.device.model || '');

    const browserInfo = browserName
        ? `${browserName}${browserVersion ? ' ' + browserVersion : ''}`
        : '';
    const osInfo = osName ? `${osName}${osVersion ? ' ' + osVersion : ''}` : '';
    const deviceInfo =
        deviceVendor || deviceModel
            ? ` (${[deviceVendor, deviceModel].filter(Boolean).join(' ')})`
            : '';

    const platform = browserInfo && osInfo ? `${browserInfo} on ${osInfo}` : browserInfo || osInfo;
    const userAgentDisplay = platform
        ? render('server/partials/user-agent-display', {
              PLATFORM: platform,
              DEVICE_INFO: deviceInfo,
          })
        : '';

    return renderTemplate(response, { USER_AGENT: userAgentDisplay });
}

async function refreshDiscordServers(bot, discordID) {
    const tokens = auth.getDiscordTokens(discordID);
    if (!tokens || !tokens.discord_refresh_token) return;

    // Only refresh if token is expired or expires in the next 5 minutes
    const now = Math.floor(Date.now() / 1000);
    let accessToken = tokens.discord_access_token;

    const {
        DISCORD_CLIENT_ID,
        DISCORD_CLIENT_SECRET,
        DISCORD_REDIRECT_URL,
    } = require('../index.js');

    if (!tokens.discord_token_expires || tokens.discord_token_expires < now + 300) {
        if (!DISCORD_CLIENT_SECRET) {
            console.error('DISCORD_CLIENT_SECRET not configured, cannot refresh token');
            return;
        }

        try {
            const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
                method: 'POST',
                body: new URLSearchParams({
                    client_id: DISCORD_CLIENT_ID,
                    client_secret: DISCORD_CLIENT_SECRET,
                    grant_type: 'refresh_token',
                    refresh_token: tokens.discord_refresh_token,
                }),
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            });
            const tokenData = await tokenResponse.json();
            if (tokenData.access_token) {
                accessToken = tokenData.access_token;
                auth.saveDiscordTokens(
                    discordID,
                    tokenData.access_token,
                    tokenData.refresh_token,
                    now + (tokenData.expires_in || 0)
                );
            } else {
                console.error('Failed to refresh Discord token:', tokenData);
                return;
            }
        } catch (err) {
            console.error('Error refreshing Discord token:', err);
            return;
        }
    }

    if (!accessToken) return;

    try {
        const oauthClient = new SnowTransfer(`Bearer ${accessToken}`);
        const guilds = await oauthClient.user.getGuilds();
        const filteredServers = guilds.filter((e) => bot.client.guilds.cache.has(e.id));
        const readyServers = filteredServers.map(function (e) {
            return { serverID: e.id, discordID: discordID, icon: e.icon };
        });
        auth.insertServers(readyServers);

        // Handle icons (minimal version of what's in index.js)
        for (const server of readyServers) {
            if (server.icon) {
                const iconDir = path.resolve(`pages/static/ico/server`, sanitizer(server.serverID));
                const iconPath = path.resolve(
                    iconDir,
                    sanitizer(
                        `${server.icon.startsWith('a_') ? server.icon.substring(2) : server.icon}.gif`
                    )
                );

                if (!fs.existsSync(iconPath)) {
                    await fs.promises.mkdir(iconDir, { recursive: true });
                    if (server.icon.startsWith('a_')) {
                        const iconData = await (
                            await fetch(
                                `https://cdn.discordapp.com/icons/${server.serverID}/${server.icon}.gif?size=128`
                            )
                        ).arrayBuffer();
                        await fs.promises.writeFile(iconPath, Buffer.from(iconData));
                    } else {
                        const iconData = await (
                            await fetch(
                                `https://cdn.discordapp.com/icons/${server.serverID}/${server.icon}.png?size=128`
                            )
                        ).arrayBuffer();
                        await sharp(Buffer.from(iconData)).toFile(iconPath);
                    }
                }
            }
        }
    } catch (err) {
        console.error('Error refreshing Discord guilds:', err);
    }
}
