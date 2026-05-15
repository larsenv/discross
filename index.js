'use strict';
require('./src/instrument.js');
require('dotenv').config({ quiet: true });
const path = require('path');
const fs = require('fs');
const mime = require('mime-types').lookup;
const { SnowTransfer } = require('snowtransfer');
const bot = require('./src/bot.js');
const connectionHandler = require('./src/connectionHandler.js');
const sharp = require('sharp');
const sanitizer = require('path-sanitizer').default;
const Sentry = require('@sentry/node');

const options = {};

const sentryEnabled = !!process.env.SENTRY_DSN;

process.on('unhandledRejection', (err) => {
    console.error(err);
});

process.on('uncaughtException', (err) => {
    console.error(err);
    if (sentryEnabled) {
        Sentry.flush(2000).finally(() => process.exit(1));
    } else {
        process.exit(1);
    }
});

const http = require('http');

const auth = require('./src/authentication.js');
auth.setHTTPS(false); // Cookies will not have the Secure; option as it's handled by reverse proxy

// Page handlers
const indexpage = require('./pages/index.js');
const loginpage = require('./pages/login.js');
const registerpage = require('./pages/register.js');
const forgotpage = require('./pages/forgot.js');
const channelpage = require('./pages/channel.js');
const serverpage = require('./pages/server.js');
const sendpage = require('./pages/send.js');
const uploadpage = require('./pages/upload.js');
const channelreplypage = require('./pages/channelReply.js');
const replypage = require('./pages/reply.js');
const drawpage = require('./pages/draw.js');
const pinspage = require('./pages/pins.js');
const changepasswordpage = require('./pages/changePassword.js');
const setup2fapage = require('./pages/setup2FA.js');
const privacypage = require('./pages/privacy.js');
const termspage = require('./pages/terms.js');
const creditspage = require('./pages/credits.js');
const guestpage = require('./pages/guest.js');
const guestsendpage = require('./pages/guestSend.js');
const newspage = require('./pages/news.js');
const weatherpage = require('./pages/weather.js');
const currencypage = require('./pages/currency.js');
const sportspage = require('./pages/sports.js');
const stockspage = require('./pages/stocks.js');
const searchpage = require('./pages/search.js');
const foodpage = require('./pages/food.js');
const tvpage = require('./pages/tv.js');
const moviespage = require('./pages/movies.js');
const notFound = require('./pages/notFound.js');

// Specialized handlers
const { toggleTheme } = require('./pages/themeToggle.js');
const { imageProxy } = require('./pages/imageProxy.js');
const { fileProxy } = require('./pages/fileProxy.js');
const { toggleImages } = require('./pages/toggleImages.js');
const { uploadFile } = require('./pages/uploadFile.js');
const senddrawing = require('./pages/sendDrawing.js');
const { handleServerIcon } = require('./pages/serverIconHandler.js');

// Constants for imageProxy path lengths
const EXTERNAL_PROXY_PREFIX_LENGTH = '/imageProxy/external/'.length; // 21

bot.startBot();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URL = process.env.DISCORD_REDIRECT_URL;

exports.DISCORD_TOKEN = DISCORD_TOKEN;
exports.DISCORD_CLIENT_ID = DISCORD_CLIENT_ID;
exports.DISCORD_CLIENT_SECRET = DISCORD_CLIENT_SECRET;
exports.DISCORD_REDIRECT_URL = DISCORD_REDIRECT_URL;

const { isValidSnowflake, parseCookies, getTemplate } = require('./pages/utils.js');

// create a server object:
const server = http.createServer(options);
connectionHandler.startWsServer(server);

// In-memory cache for static files served via servePage()
// Cache entry format: { data: Buffer, mtime: Date }
const staticFileCache = new Map();
const STATIC_CACHE_MAX_FILES = 2000; // max distinct files to cache (FIFO eviction)
const STATIC_CACHE_MAX_BYTES = 1024 * 1024; // skip caching individual files larger than 1 MB

async function servePage(filename, res, type, textToReplace, replacement, req) {
    if (!type) {
        type = mime(filename);
    }
    if (filename.endsWith('/')) {
        filename += 'index.html';
    }

    // Serve from in-memory cache for plain (non-templated) requests
    if (!textToReplace && staticFileCache.has(filename)) {
        const cacheEntry = staticFileCache.get(filename);

        // Check if file has been modified since caching
        try {
            const stats = fs.statSync(filename);
            if (stats.mtime.getTime() === cacheEntry.mtime.getTime()) {
                // File unchanged, serve from cache
                res.writeHead(200, {
                    'Content-Type': type,
                    'Cache-Control': 'public, max-age=3600',
                });
                return res.end(cacheEntry.data);
            }
            // File modified, remove from cache and continue to read from disk
            staticFileCache.delete(filename);
        } catch (err) {
            // If we can't stat the file, invalidate cache and continue
            staticFileCache.delete(filename);
            if (typeof sentryEnabled !== 'undefined' && sentryEnabled) Sentry.captureException(err);
        }
    }

    fs.readFile(filename, function (err, data) {
        if (err) {
            //try to find something
            if (filename.endsWith('index.html')) {
                return notFound.serve404(req, res, 'Page not found.', '/', 'Back to Home');
            } else {
                servePage(filename + '/index.html', res, undefined, undefined, undefined, req);
                return;
            }
        }
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });

        const isText =
            type &&
            (type.startsWith('text/') ||
                type === 'application/javascript' ||
                type === 'application/json' ||
                type === 'image/svg+xml');

        if (isText) {
            let content = data.toString();
            // Always apply global replacements for client-side JS and other static files
            content = content.replaceAll('{{DISCORD_CLIENT_ID}}', DISCORD_CLIENT_ID);
            content = content.replaceAll('{{DISCORD_REDIRECT_URL}}', DISCORD_REDIRECT_URL);

            if (textToReplace && replacement) {
                res.end(content.replace(textToReplace, replacement));
            } else {
                if (data.length <= STATIC_CACHE_MAX_BYTES) {
                    if (staticFileCache.size >= STATIC_CACHE_MAX_FILES) {
                        staticFileCache.delete(staticFileCache.keys().next().value);
                    }
                    // Get modification time and store in cache
                    try {
                        const stats = fs.statSync(filename);
                        staticFileCache.set(filename, {
                            data: data,
                            mtime: stats.mtime,
                        });
                    } catch (err) {
                        // If we can't stat the file, still serve it but don't cache
                        console.warn('Could not stat file for caching:', filename, err);
                        if (typeof sentryEnabled !== 'undefined' && sentryEnabled)
                            Sentry.captureException(err);
                    }
                }
                res.end(content);
            }
        } else {
            // Binary file (fonts, images, etc.) - serve as raw buffer without replacements
            if (data.length <= STATIC_CACHE_MAX_BYTES) {
                if (staticFileCache.size >= STATIC_CACHE_MAX_FILES) {
                    staticFileCache.delete(staticFileCache.keys().next().value);
                }
                try {
                    const stats = fs.statSync(filename);
                    staticFileCache.set(filename, {
                        data: data,
                        mtime: stats.mtime,
                    });
                } catch (err) {
                    console.warn('Could not stat file for caching:', filename, err);
                    if (typeof sentryEnabled !== 'undefined' && sentryEnabled)
                        Sentry.captureException(err);
                }
            }
            res.end(data);
        }
    });
}

// File watching for hot-reload (monitors pages/, templates/, and static files)
// File watching for hot-reload (monitors ENTIRE pages folder - all files)
function setupFileWatchers() {
    if (process.env.HOT_RELOAD !== 'true') {
        return;
    }

    console.log('Hot-reload enabled: Monitoring ENTIRE pages/ folder');

    const pagesDir = path.resolve('pages');
    try {
        fs.watch(pagesDir, { recursive: true }, (eventType, filename) => {
            if (!filename) return;
            const fullPath = path.join(pagesDir, filename);
            if (staticFileCache.has(fullPath)) {
                staticFileCache.delete(fullPath);
            }
            console.log('Hot-reload:', filename);
        });
    } catch (err) {
        console.error('Failed to watch pages/:', err);
    }
}

setupFileWatchers();

async function senddrawingAsync(req, res, body) {
    const discordID = await auth.checkAuth(req, res);

    // Validate body is not empty
    if (!body || body.trim() === '') {
        console.log('Error: senddrawingAsync received empty body');
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(getTemplate('no-data-received', 'misc'));
        return;
    }

    // Use URLSearchParams to handle large base64 data
    const urlQuery = Object.fromEntries(new URLSearchParams(body));

    if (!urlQuery || !urlQuery.drawinginput) {
        console.log('Error: senddrawingAsync - drawinginput not found in parsed URL query');
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(getTemplate('invalid-drawing-data', 'misc'));
        return;
    }

    if (discordID) {
        await senddrawing.sendDrawing(bot, req, res, [], discordID, urlQuery);
    }
}

async function handlePost(req, res) {
    const parsedurl = new URL(req.url, 'http://localhost').pathname;

    // Handle file upload BEFORE reading body (formidable needs raw stream)
    if (parsedurl === '/uploadFile') {
        req.setTimeout(30 * 60 * 1000);
        res.setTimeout(30 * 60 * 1000);

        try {
            const discordID = await auth.checkAuth(req, res, true);
            if (discordID) {
                await uploadFile(bot, req, res, [], discordID);
            } else if (!res.headersSent) {
                const isTraditional =
                    new URL(req.url, 'http://localhost').searchParams.get('traditional') === 'true';
                if (isTraditional) {
                    res.writeHead(302, { Location: '/login.html' });
                    res.end();
                } else {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Not authenticated' }));
                }
            }
        } catch (err) {
            console.error(err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Internal Server Error' }));
        }
        return;
    }

    // For all other POST requests, read the body
    let body = '';
    req.on('data', (chunk) => {
        body += chunk.toString();
    });
    req.on('error', (err) => {
        console.error('Error reading request body:', err);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end(getTemplate('error-reading-data', 'misc'));
        }
    });
    req.on('end', async () => {
        try {
            if (parsedurl === '/toggleCategory') {
                const discordID = await auth.checkAuth(req, res, true);
                if (discordID) {
                    const data = JSON.parse(body);
                    const { serverID, categoryID, collapsed } = data;
                    const result = auth.setChannelPreference(
                        discordID,
                        serverID,
                        categoryID,
                        collapsed ? 1 : 0
                    );
                    res.writeHead(result.success ? 200 : 500, {
                        'Content-Type': 'application/json',
                    });
                    res.end(JSON.stringify(result));
                } else {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Not authenticated' }));
                }
            } else if (parsedurl === '/senddrawing') {
                await senddrawingAsync(req, res, body);
            } else if (parsedurl === '/changepassword') {
                const discordID = await auth.checkAuth(req, res, true);
                if (discordID) {
                    await changepasswordpage.handleChangePassword(bot, req, res, body, discordID);
                } else {
                    res.writeHead(302, { Location: '/login.html' });
                    res.end();
                }
            } else if (parsedurl === '/setup2fa') {
                const discordID = await auth.checkAuth(req, res, true);
                if (discordID) {
                    await setup2fapage.handleSetup2FA(bot, req, res, body, discordID);
                } else {
                    res.writeHead(302, { Location: '/login.html' });
                    res.end();
                }
            } else if (parsedurl === '/disable2fa') {
                const discordID = await auth.checkAuth(req, res, true);
                if (discordID) {
                    await setup2fapage.handleDisable2FA(bot, req, res, body, discordID);
                } else {
                    res.writeHead(302, { Location: '/login.html' });
                    res.end();
                }
            } else if (parsedurl.startsWith('/food/')) {
                const discordID = await auth.checkAuth(req, res);
                if (discordID) {
                    await foodpage.handlePost(bot, req, res, discordID, body);
                }
            } else {
                await auth.handleLoginRegister(req, res, body);
            }
        } catch (err) {
            console.error('POST handler error:', err);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/html' });
                res.end(getTemplate('internal-server-error', 'misc'));
            }
        }
    });
}

async function handleGet(req, res) {
    const parsedurl = new URL(req.url, 'http://localhost');
    const args = parsedurl.pathname.replaceAll('?', '/').split('/');

    switch (args[1]) {
        case 'send': {
            const discordID = await auth.checkAuth(req, res);
            if (discordID) await sendpage.sendMessage(bot, req, res, args, discordID);
            break;
        }
        case 'reply': {
            const discordID = await auth.checkAuth(req, res);
            if (discordID) await replypage.replyMessage(bot, req, res, args, discordID);
            break;
        }
        case 'switchtheme':
            toggleTheme(req, res);
            break;
        case 'toggleImages':
            toggleImages(req, res);
            break;
        case 'logout': {
            const discordID = await auth.checkAuth(req, res, true);
            if (discordID) auth.logout(discordID);
            res.writeHead(302, { Location: '/' });
            res.end();
            break;
        }
        case 'server': {
            const discordID = await auth.checkAuth(req, res);
            if (discordID) await serverpage.processServer(bot, req, res, args, discordID);
            break;
        }
        case 'channels': {
            const discordID = await auth.checkAuth(req, res, true);
            if (args.length === 3) {
                if (discordID) {
                    await channelpage.processChannel(bot, req, res, args, discordID);
                } else if (isValidSnowflake(args[2]) && auth.isGuestChannel(args[2])) {
                    await guestpage.processGuestChannel(bot, req, res, args[2]);
                } else {
                    res.writeHead(303, {
                        Location: '/login.html?redirect=' + encodeURIComponent(req.url),
                    });
                    res.end();
                }
            } else if (args.length === 4) {
                if (discordID) {
                    if (args[3].length === 0) {
                        res.writeHead(302, { Location: `/channels/${args[2]}#end` });
                        res.end();
                    } else {
                        await channelreplypage.processChannelReply(bot, req, res, args, discordID);
                    }
                } else {
                    res.writeHead(303, {
                        Location: '/login.html?redirect=' + encodeURIComponent(req.url),
                    });
                    res.end();
                }
            } else {
                const redirectPath = discordID
                    ? `/channels/${args[2]}#end`
                    : '/login.html?redirect=' + encodeURIComponent(req.url);
                res.writeHead(discordID ? 302 : 303, { Location: redirectPath });
                res.end();
            }
            break;
        }
        case 'guest_name':
            await guestpage.processGuestName(req, res);
            break;
        case 'guest_send':
            await guestsendpage.guestSend(bot, req, res);
            break;
        case 'jobs':
            res.writeHead(302, { Location: 'http://careers.mcdonalds.com/' });
            res.end();
            break;
        case 'upload': {
            const discordID = await auth.checkAuth(req, res);
            if (discordID) await uploadpage.processUpload(bot, req, res, args, discordID);
            break;
        }
        case 'pins': {
            const discordID = await auth.checkAuth(req, res);
            if (discordID) await pinspage.processPins(bot, req, res, args, discordID);
            break;
        }
        case 'signmessage': {
            const discordID = await auth.checkAuth(req, res);
            if (discordID) {
                const sendMetaPage = require('./pages/sendMeta.js');
                await sendMetaPage.sendMeta(bot, req, res, args[2]);
            }
            break;
        }
        case 'news': {
            const discordID = await auth.checkAuth(req, res);
            if (discordID) {
                if (args.length >= 3 && args[2]) {
                    await newspage.processNewsArticle(req, res, args, discordID);
                } else {
                    await newspage.processNews(req, res, args, discordID);
                }
            }
            break;
        }
        case 'draw': {
            const discordID = await auth.checkAuth(req, res);
            if (discordID) await drawpage.processDraw(bot, req, res, args, discordID);
            break;
        }
        case 'sendactioncode': {
            const discordID = await auth.checkAuth(req, res, true);
            if (!discordID) {
                res.writeHead(302, { Location: '/login.html' });
                res.end();
            } else {
                const returnPages = {
                    changepassword: '/change-password.html',
                    setup2fa: '/setup-2fa.html',
                    disable2fa: '/setup-2fa.html',
                };
                const actionParam = parsedurl.searchParams.get('action');
                if (!returnPages[actionParam]) {
                    res.writeHead(302, { Location: '/server/' });
                    res.end();
                } else {
                    const sessionParam = parsedurl.searchParams.get('sessionID')
                        ? '?sessionID=' +
                          encodeURIComponent(parsedurl.searchParams.get('sessionID'))
                        : '';
                    const code = auth.createActionCode(discordID, actionParam);
                    const dmMessages = {
                        changepassword: `Your Discross verification code to change your password: **${code}**\nThis code expires in 10 minutes.`,
                        setup2fa: `Your Discross verification code to set up two-factor authentication: **${code}**\nThis code expires in 10 minutes.`,
                        disable2fa: `Your Discross verification code to disable two-factor authentication: **${code}**\nThis code expires in 10 minutes.`,
                    };
                    const dmResult = await bot.sendDM(discordID, dmMessages[actionParam]);
                    const returnPath = returnPages[actionParam];
                    res.writeHead(302, {
                        Location: dmResult.success
                            ? `${returnPath}${sessionParam}${sessionParam ? '&' : '?'}codesent=1`
                            : `${returnPath}${sessionParam}${sessionParam ? '&' : '?'}errortext=${encodeURIComponent('Could not send a verification code to your Discord DMs. Make sure you allow DMs from server members, then try again.')}`,
                    });
                    res.end();
                }
            }
            break;
        }
        case 'login.html':
            await loginpage.processLogin(bot, req, res, args);
            break;
        case 'register.html':
            await registerpage.processRegister(bot, req, res, args);
            break;
        case 'forgot.html':
            await forgotpage.processForgot(bot, req, res, args);
            break;
        case 'change-password.html':
            await changepasswordpage.processChangePassword(bot, req, res, args);
            break;
        case 'setup-2fa.html':
            await setup2fapage.processSetup2FA(bot, req, res, args);
            break;
        case 'index.html':
            await indexpage.processIndex(bot, req, res, args);
            break;
        case 'privacy.html':
            await privacypage.processPrivacy(bot, req, res, args);
            break;
        case 'terms.html':
            await termspage.processTerms(bot, req, res, args);
            break;
        case 'credits.html':
        case 'credits':
            await creditspage.processCredits(bot, req, res, args);
            break;
        case 'weather':
            await weatherpage.processWeather(req, res);
            break;
        case 'currency':
            await currencypage.processCurrency(req, res);
            break;
        case 'sports':
            await sportspage.processSports(req, res);
            break;
        case 'stocks':
            await stockspage.processStocks(req, res);
            break;
        case 'search':
            await searchpage.processSearch(req, res);
            break;
        case 'tv':
            await tvpage.processTV(req, res);
            break;
        case 'movies': {
            const discordID = await auth.checkAuth(req, res);
            if (discordID) await moviespage.processMovies(req, res, discordID);
            break;
        }
        case 'food': {
            const discordID = await auth.checkAuth(req, res);
            if (discordID) await foodpage.handleGet(bot, req, res, discordID);
            break;
        }
        case 'foodProxy':
            await foodpage.foodProxy(req, res);
            break;
        case 'discord':
            // OAuth logic (remains inline for now due to complexity, but grouped in switch)
            await handleDiscordOAuth(req, res, parsedurl);
            break;
        case 'imageProxy':
            await handleImageProxy(req, res, parsedurl, args);
            break;
        case 'fileProxy': {
            const filePath = req.url.slice(11);
            await fileProxy(res, `https://cdn.discordapp.com/attachments/${filePath}`);
            break;
        }
        case 'ico':
            if (args[2] === 'server' && args[3] && args[4]) {
                const discordID = await auth.checkAuth(req, res, true);
                const iconHash = args[4].replace('.gif', '');
                const urlTheme = discordID ? parsedurl.searchParams.get('theme') : null;
                const { whiteThemeCookie } = discordID ? parseCookies(req) : {};
                const themeValue = urlTheme ?? whiteThemeCookie ?? null;
                const theme = themeValue === '1' ? 'light' : themeValue === '2' ? 'amoled' : 'dark';
                await handleServerIcon(bot, res, args[3], iconHash, theme);
            }
            break;
        default:
            if (parsedurl.pathname === '/') {
                await indexpage.processIndex(bot, req, res, args);
            } else {
                const filename = path.resolve('pages/static', sanitizer(parsedurl.pathname));
                await servePage(filename, res, undefined, undefined, undefined, req);
            }
    }
}

async function handleDiscordOAuth(req, res, parsedurl) {
    const discordID = await auth.checkAuth(req, res);
    if (!discordID) return;

    try {
        const query = parsedurl.searchParams;
        let accessToken = query.get('access_token');
        let tokenType = query.get('token_type') || 'Bearer';
        const code = query.get('code');

        if (code) {
            if (!DISCORD_CLIENT_SECRET) {
                res.writeHead(500, { 'Content-Type': 'text/html' });
                res.end(getTemplate('discord-secret-not-configured', 'misc'));
                return;
            }
            const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
                method: 'POST',
                body: new URLSearchParams({
                    client_id: DISCORD_CLIENT_ID,
                    client_secret: DISCORD_CLIENT_SECRET,
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: DISCORD_REDIRECT_URL,
                }),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            });
            const tokenData = await tokenResponse.json();
            if (tokenData.access_token) {
                accessToken = tokenData.access_token;
                tokenType = tokenData.token_type || 'Bearer';
                auth.saveDiscordTokens(
                    discordID,
                    tokenData.access_token,
                    tokenData.refresh_token,
                    Math.floor(Date.now() / 1000) + (tokenData.expires_in || 0)
                );
            } else {
                throw new Error('Failed to exchange code: ' + JSON.stringify(tokenData));
            }
        }

        if (!accessToken) {
            res.writeHead(302, { Location: '/' });
            res.end();
            return;
        }

        const oauthClient = new SnowTransfer(`${tokenType} ${accessToken}`);
        const user = await oauthClient.user.getSelf();
        if (user && user.id === discordID) {
            const guilds = await oauthClient.user.getGuilds();
            const readyServers = guilds
                .filter((e) => bot.client.guilds.cache.has(e.id))
                .map((e) => ({ serverID: e.id, discordID, icon: e.icon }));

            auth.insertServers(readyServers);

            // Icon sync logic
            for (const srv of readyServers) {
                if (srv.icon) {
                    const serverDir = path.resolve(
                        'pages/static/ico/server',
                        sanitizer(srv.serverID)
                    );
                    await fs.promises.mkdir(serverDir, { recursive: true });
                    const isAnimated = srv.icon.startsWith('a_');
                    const ext = isAnimated ? 'gif' : 'png';
                    const iconUrl = `https://cdn.discordapp.com/icons/${srv.serverID}/${srv.icon}.${ext}?size=128`;
                    const iconResponse = await fetch(iconUrl);
                    if (iconResponse.ok) {
                        const buffer = Buffer.from(await iconResponse.arrayBuffer());
                        const finalPath = path.resolve(
                            serverDir,
                            sanitizer(`${srv.icon.replace('a_', '')}.gif`)
                        );
                        if (isAnimated) {
                            await fs.promises.writeFile(finalPath, buffer);
                        } else {
                            await sharp(buffer).toFile(finalPath);
                        }
                    }
                }
            }

            if (query.get('state') === 'sync') {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(getTemplate('sync-complete-script', 'misc'));
            } else {
                res.writeHead(302, { Location: '/server/' });
                res.end();
            }
        } else {
            res.writeHead(302, { Location: '/' });
            res.end();
        }
    } catch (e) {
        console.error('OAuth error:', e);
        res.writeHead(302, { Location: '/' });
        res.end();
    }
}

async function handleImageProxy(req, res, parsedurl, args) {
    const isFull = parsedurl.searchParams.get('full') === '1';
    if (args[2] === 'external') {
        const encodedUrl = req.url.slice(EXTERNAL_PROXY_PREFIX_LENGTH).split('?')[0];
        const fullImageUrl = Buffer.from(encodedUrl, 'base64').toString();
        await imageProxy(res, fullImageUrl, isFull);
    } else if (args[2] === 'sticker') {
        const stickerId = args[3].replace(/\.[^.]*$/, '');
        await imageProxy(res, `https://media.discordapp.net/stickers/${stickerId}.png`, isFull);
    } else {
        const urlObj = new URL(req.url, 'http://localhost');
        urlObj.searchParams.delete('full');
        const fullImageUrl = `https://cdn.discordapp.com/${args[2] === 'emoji' ? 'emojis' : 'attachments'}/${args[2] === 'emoji' ? urlObj.pathname.slice(18) : urlObj.pathname.slice(12)}${urlObj.search}`;
        await imageProxy(res, fullImageUrl, isFull);
    }
}

server.on('request', async (req, res) => {
    if (req.url.startsWith('//')) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(getTemplate('invalid-request-url', 'misc'));
        return;
    }

    try {
        if (req.method === 'POST') {
            await handlePost(req, res);
        } else {
            await handleGet(req, res);
        }
    } catch (err) {
        console.error('Request error:', err);
        if (sentryEnabled) Sentry.captureException(err);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end(getTemplate('internal-server-error', 'misc'));
        }
    }
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port 4000 is already in use. Failed to start server.`);
        process.exit(1);
    } else {
        console.error('Server error:', err);
    }
});

server.listen(4000);
