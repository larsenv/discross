'use strict';
require('./src/instrument');
require('dotenv').config({ quiet: true });
const path = require('path');
const fs = require('fs');
const mime = require('mime-types').lookup;
const { SnowTransfer } = require('snowtransfer');
const bot = require('./src/bot');
const connectionHandler = require('./src/connectionHandler');
const mail = require('./src/mail');
const sharp = require('sharp');
const sanitizer = require('path-sanitizer').default;
const escapeHtml = require('escape-html');
const Sentry = require('@sentry/node');

const options = {};

const sentryEnabled = !!process.env.SENTRY_DSN;

process.on('SIGINT', async () => {
    console.info('Shutting down gracefully...');
    if (bot.client) {
        bot.client.destroy();
    }
    if (sentryEnabled) {
        await Sentry.flush(2000);
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.info('Shutting down gracefully...');
    if (bot.client) {
        bot.client.destroy();
    }
    if (sentryEnabled) {
        await Sentry.flush(2000);
    }
    process.exit(0);
});

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

const auth = require('./src/authentication');
auth.setHTTPS(false); // Cookies will not have the Secure; option as it's handled by reverse proxy

// Page handlers
const indexpage = require('./pages/index');
const loginpage = require('./pages/login');
const registerpage = require('./pages/register');
const forgotpage = require('./pages/forgot');
const channelpage = require('./pages/channel');
const serverpage = require('./pages/server');
const sendpage = require('./pages/send');
const uploadpage = require('./pages/upload');
const channelreplypage = require('./pages/channelReply');
const replypage = require('./pages/reply');
const drawpage = require('./pages/draw');
const drawtestpage = require('./pages/drawTest');
const pinspage = require('./pages/pins');
const changepasswordpage = require('./pages/changePassword');
const setup2fapage = require('./pages/setup2FA');
const privacypage = require('./pages/privacy');
const termspage = require('./pages/terms');
const creditspage = require('./pages/credits');
const guestpage = require('./pages/guest');
const guestsendpage = require('./pages/guestSend');
const newspage = require('./pages/news');
const weatherpage = require('./pages/weather');
const currencypage = require('./pages/currency');
const sportspage = require('./pages/sports');
const stockspage = require('./pages/stocks');
const searchpage = require('./pages/search');
const foodpage = require('./pages/food');
const tvpage = require('./pages/tv');
const moviespage = require('./pages/movies');
const notFound = require('./pages/notFound');

// Specialized handlers
const { toggleTheme } = require('./pages/themeToggle');
const { imageProxy } = require('./pages/imageProxy');
const { fileProxy } = require('./pages/fileProxy');
const { toggleImages } = require('./pages/toggleImages');
const { uploadFile } = require('./pages/uploadFile');
const senddrawing = require('./pages/sendDrawing');
const { handleServerIcon } = require('./pages/serverIconHandler');

// Constants for imageProxy path lengths
const EXTERNAL_PROXY_PREFIX_LENGTH = '/imageProxy/external/'.length; // 21

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URL = (process.env.DISCORD_REDIRECT_URL || '').trim();

exports.DISCORD_TOKEN = DISCORD_TOKEN;
exports.DISCORD_CLIENT_ID = DISCORD_CLIENT_ID;
exports.DISCORD_CLIENT_SECRET = DISCORD_CLIENT_SECRET;
exports.DISCORD_REDIRECT_URL = DISCORD_REDIRECT_URL;

const {
    isValidSnowflake,
    getTemplate,
    renderTemplate,
    getPageThemeAttr,
    loadAndRenderPageTemplate,
    resolveThemeValue,
    toLocalPath,
    isCrossSiteRequest,
    generateSEOMetadata,
} = require('./pages/utils');

const messagePageTemplate = loadAndRenderPageTemplate('message');

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
                            data: isText ? Buffer.from(content, 'utf8') : data,
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

    // Cookie/URL auth first; fall back to the sessionID posted in the form body.
    // Legacy consoles (Wii Internet Channel with cleared save data) have no
    // cookies, and the draw form carries the session only as a hidden input.
    let discordID = await auth.checkAuth(req, res, true);
    if (!discordID && urlQuery.sessionID) {
        discordID = await auth.checkSession(urlQuery.sessionID);
    }
    if (!discordID) {
        res.writeHead(303, {
            Location: `/login.html?redirect=${encodeURIComponent(req.url)}`,
        });
        res.end();
        return;
    }

    await senddrawing.sendDrawing(bot, req, res, [], discordID, urlQuery);
}

async function handlePost(req, res) {
    const parsedurl = new URL(req.url, 'http://localhost').pathname;

    // Every POST here is a form or fetch from one of our own pages, except the
    // Resend webhook, which is a server-to-server call that carries no Fetch
    // Metadata. SameSite=Lax already keeps the session cookie off cross-site
    // POSTs; this also stops login, registration and the other cookieless
    // endpoints from being driven by a hostile page.
    if (parsedurl !== '/api/inbound/mail' && isCrossSiteRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        res.end(getTemplate('no-permission', 'misc'));
        return;
    }

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

    // For all other POST requests, read the body. Cap the buffered size so a
    // single large request can't exhaust memory — these endpoints only ever
    // carry small form/JSON payloads (file uploads are handled above via a
    // streaming parser and never reach here).
    const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB
    let bodyChunks = [];
    let bodyBytes = 0;
    let bodyTooLarge = false;
    req.on('data', (chunk) => {
        if (bodyTooLarge) return;
        bodyBytes += chunk.length;
        if (bodyBytes > MAX_BODY_BYTES) {
            bodyTooLarge = true;
            bodyChunks = [];
            if (!res.headersSent) {
                res.writeHead(413, { 'Content-Type': 'text/html' });
                res.end(getTemplate('error-reading-data', 'misc'));
            }
            req.destroy();
            return;
        }
        bodyChunks.push(chunk);
    });
    req.on('error', (err) => {
        console.error('Error reading request body:', err);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end(getTemplate('error-reading-data', 'misc'));
        }
    });
    req.on('end', async () => {
        if (bodyTooLarge) return; // already responded with 413
        try {
            const body = Buffer.concat(bodyChunks).toString();
            if (parsedurl === '/api/inbound/mail') {
                try {
                    req.rawBody = body;
                    req.body = JSON.parse(body);
                    await mail.handleInboundWebhook(req, res);
                } catch (err) {
                    console.error('Invalid JSON in inbound mail webhook', err);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON' }));
                }
                return;
            }

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
            } else if (parsedurl === '/nsfw/confirm') {
                const discordID = await auth.checkAuth(req, res, true);
                if (!discordID) {
                    res.writeHead(303, { Location: '/login.html' });
                    res.end();
                    return;
                }
                const form = new URLSearchParams(body);
                if (
                    !auth.verifyActionToken(
                        auth.getRequestSessionID(req),
                        'nsfwconfirm',
                        form.get('token')
                    )
                ) {
                    res.writeHead(403, { 'Content-Type': 'text/html' });
                    res.end(getTemplate('no-permission', 'misc'));
                    return;
                }
                auth.confirmAdult(discordID);
                res.writeHead(303, { Location: toLocalPath(form.get('return') || '/server/') });
                res.end();
            } else if (parsedurl === '/senddrawing') {
                await senddrawingAsync(req, res, body);
            } else if (
                parsedurl === '/changepassword' ||
                parsedurl === '/changepassword.html' ||
                parsedurl === '/change-password' ||
                parsedurl === '/change-password.html'
            ) {
                const discordID = await auth.checkAuth(req, res, true);
                if (discordID) {
                    await changepasswordpage.handleChangePassword(bot, req, res, body, discordID);
                } else {
                    res.writeHead(302, { Location: '/login.html' });
                    res.end();
                }
            } else if (
                parsedurl === '/setup2fa' ||
                parsedurl === '/setup2fa.html' ||
                parsedurl === '/setup-2fa' ||
                parsedurl === '/setup-2fa.html'
            ) {
                const discordID = await auth.checkAuth(req, res, true);
                if (discordID) {
                    await setup2fapage.handleSetup2FA(bot, req, res, body, discordID);
                } else {
                    res.writeHead(302, { Location: '/login.html' });
                    res.end();
                }
            } else if (
                parsedurl === '/disable2fa' ||
                parsedurl === '/disable2fa.html' ||
                parsedurl === '/disable-2fa' ||
                parsedurl === '/disable-2fa.html'
            ) {
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
            } else if (parsedurl === '/passkey/verify') {
                const type =
                    new URL(req.url, 'http://localhost').searchParams.get('type') || 'register';
                let discordID;
                const data = JSON.parse(body);

                if (type === 'login') {
                    // For login, we need to lookup discordID from credential ID
                    const passkey = auth.querySingle(
                        'SELECT discordID FROM passkeys WHERE credentialID = ?',
                        [data.id]
                    );

                    discordID = passkey ? passkey.discordID : null;
                } else {
                    discordID = await auth.checkAuth(req, res, true);
                }

                if (discordID) {
                    const result = await auth.verifyPasskey(discordID, type, data);
                    if (result.success && type === 'login') {
                        const sessionID = auth.createSession(discordID);
                        res.writeHead(200, {
                            'Set-Cookie': auth.getCookieHeader(sessionID),
                            'Content-Type': 'application/json',
                        });
                        res.end(JSON.stringify({ success: true, sessionID: sessionID }));
                    } else {
                        res.writeHead(result.success ? 200 : 500, {
                            'Content-Type': 'application/json',
                        });
                        res.end(JSON.stringify(result));
                    }
                } else {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(
                        JSON.stringify({
                            success: false,
                            error: 'Not authenticated or invalid credential',
                        })
                    );
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
        case 'passkey': {
            if (args[2] === 'options') {
                // This endpoint is fetched by client JS that calls response.json()
                // unconditionally, so it must ALWAYS answer with JSON. Without this
                // guard a throw here (or in checkAuth/getPasskeyOptions) fell
                // through to the outer handler's HTML error page, and the browser
                // reported it as the opaque "JSON.parse: unexpected character at
                // line 1 column 1" rather than anything actionable.
                try {
                    const type = parsedurl.searchParams.get('type') || 'register';
                    let discordID;
                    if (type === 'login') {
                        // For login, we need to lookup discordID by username first
                        const username = parsedurl.searchParams.get('username');
                        const user = auth.querySingle(
                            'SELECT discordID FROM users WHERE username = ?',
                            [username]
                        );

                        discordID = user ? user.discordID : null;
                    } else {
                        discordID = await auth.checkAuth(req, res, true);
                    }

                    if (discordID || type === 'login') {
                        const host =
                            req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
                        const rpId = host.split(':')[0];
                        const options = auth.getPasskeyOptions(discordID, type, rpId);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(options));
                    } else {
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'User not found or not authenticated' }));
                    }
                } catch (err) {
                    // Real cause goes to the server log; the client gets a clean
                    // JSON error it can show instead of a parse failure.
                    console.error('passkey options error:', err);
                    if (!res.headersSent) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(
                            JSON.stringify({
                                error: 'Could not create passkey options. Please try again.',
                            })
                        );
                    }
                }
            } else {
                // Any other /passkey/* GET is unknown — still answer with JSON,
                // since only JS ever hits these paths.
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unknown passkey endpoint' }));
            }
            break;
        }
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
            // A GET that clears the session, so a cross-site link or image could
            // log the user out. Only same-site requests may log out.
            const discordID = await auth.checkAuth(req, res, true);
            if (discordID && !isCrossSiteRequest(req)) auth.logout(discordID);
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
                const sendMetaPage = require('./pages/sendMeta');
                await sendMetaPage.sendMeta(bot, req, res, args[2]);
            }
            break;
        }
        case 'news': {
            const discordID = await auth.checkAuth(req, res, true);
            if (args.length >= 3 && args[2]) {
                await newspage.processNewsArticle(req, res, args, discordID);
            } else {
                await newspage.processNews(req, res, args, discordID);
            }
            break;
        }
        case 'draw': {
            const discordID = await auth.checkAuth(req, res);
            if (discordID) await drawpage.processDraw(bot, req, res, args, discordID);
            break;
        }
        // Unauthenticated harness for the Old 3DS single-canvas experiment. It cannot
        // send anything — it only renders draw.js against one <canvas> plus an event
        // readout, so it can be opened straight on the console for testing.
        case 'drawtest': {
            drawtestpage.processDrawTest(req, res);
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
                // The DM only goes out for a link this session was served. The
                // cookie is SameSite=Lax, so without this a cross-site link or a
                // prefetch could make the logged-in user's account DM them a
                // verification code they never asked for.
                const tokenOk = auth.verifyActionToken(
                    auth.getRequestSessionID(req),
                    actionParam,
                    parsedurl.searchParams.get('token')
                );
                if (!returnPages[actionParam] || !tokenOk) {
                    res.writeHead(302, { Location: returnPages[actionParam] || '/server/' });
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
        case 'login':
            await loginpage.processLogin(bot, req, res, args);
            break;
        case 'register.html':
        case 'register':
            await registerpage.processRegister(bot, req, res, args);
            break;
        case 'forgot.html':
        case 'forgot':
            await forgotpage.processForgot(bot, req, res, args);
            break;
        case 'change-password.html':
        case 'changepassword.html':
        case 'change-password':
        case 'changepassword':
            await changepasswordpage.processChangePassword(bot, req, res, args);
            break;
        case 'setup-2fa.html':
        case 'setup2fa.html':
        case 'setup-2fa':
        case 'setup2fa':
        case 'disable-2fa.html':
        case 'disable2fa.html':
        case 'disable-2fa':
        case 'disable2fa':
            await setup2fapage.processSetup2FA(bot, req, res, args);
            break;
        case 'index.html':
        case 'index':
            await indexpage.processIndex(bot, req, res, args);
            break;
        case 'privacy.html':
        case 'privacy':
            await privacypage.processPrivacy(bot, req, res, args);
            break;
        case 'terms.html':
        case 'terms':
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
            await searchpage.processSearch(bot, req, res);
            break;
        case 'tv':
            await tvpage.processTV(req, res);
            break;
        case 'movies': {
            // Optional auth check just to get discordID, but don't redirect if not logged in.
            const discordID = await auth.checkAuth(req, res, true);
            await moviespage.processMovies(req, res, discordID);
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
        case 'snake': {
            const { renderTemplate, resolveTheme, generateSEOMetadata } = require('./pages/utils');
            const theme = resolveTheme(req);
            const pageTitle = 'Snake - Discross';
            const finalHtml = renderTemplate(getTemplate('snake', 'misc'), {
                WHITE_THEME_ENABLED: theme.themeClass,
                PAGE_TITLE: pageTitle,
                SEO_METADATA: generateSEOMetadata(req, {
                    title: pageTitle,
                    description: 'Play Snake',
                }),
            });
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(finalHtml);
            break;
        }
        case 'discord':
            // OAuth logic (remains inline for now due to complexity, but grouped in switch)
            await handleDiscordOAuth(req, res, parsedurl);
            break;
        case 'imageProxy':
            await handleImageProxy(req, res, parsedurl, args);
            break;
        case 'fileProxy': {
            if (args[2] === 'external') {
                const encodedUrl = req.url.slice('/fileProxy/external/'.length).split('?')[0];
                const fullFileUrl = Buffer.from(encodedUrl, 'base64').toString();
                const allowedHosts = ['transfer.archivete.am', 'transfer.notkiska.pw', 'x0.at'];
                try {
                    const parsed = new URL(fullFileUrl);
                    if (allowedHosts.includes(parsed.hostname)) {
                        await fileProxy(res, fullFileUrl, req);
                        break;
                    }
                } catch (e) {
                    // fall through
                }
            }
            // Attachments only. Parse the joined URL first so `..` segments can't
            // climb out of /attachments/ into other paths on the Discord CDN. The
            // query string stays, since signed attachment URLs need it.
            let attachmentUrl = null;
            try {
                attachmentUrl = new URL(
                    `https://cdn.discordapp.com/attachments/${req.url.slice(11)}`
                );
            } catch (e) {
                // fall through to the 404 below
            }
            if (!attachmentUrl || !attachmentUrl.pathname.startsWith('/attachments/')) {
                await notFound.serve404(req, res, 'Page not found.', '/', 'Back to Home');
                break;
            }
            await fileProxy(res, attachmentUrl.href, req);
            break;
        }
        case 'wii': {
            // Old Wii "channel" clients redirected here (patched to point at
            // discross.net instead of their original streaming service) expect
            // this exact shape: GET /wii/time.html just needs to come back with
            // a valid Date header, which Node sets on every response by itself,
            // so any 200 works. GET /wii/ (and anything else under /wii/*) is
            // the client's real app entry point - just the normal site.
            if (args[2] === 'time.html') {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('ok');
            } else {
                await indexpage.processIndex(bot, req, res, args);
            }
            break;
        }
        case 'ico':
            if (args[2] === 'server' && args[3] && args[4]) {
                const discordID = await auth.checkAuth(req, res, true);
                const iconHash = args[4].replace('.gif', '');
                // Theme only applies for authenticated requests; guests always get dark.
                const themeValue = discordID ? resolveThemeValue(req) : 0;
                const theme = themeValue === 1 ? 'light' : themeValue === 2 ? 'amoled' : 'dark';
                await handleServerIcon(bot, res, args[3], iconHash, theme);
            } else {
                // Anything else under /ico/ would otherwise never get a response.
                await notFound.serve404(req, res, 'Page not found.', '/', 'Back to Home');
            }
            break;
        default:
            if (parsedurl.pathname === '/') {
                await indexpage.processIndex(bot, req, res, args);
            } else {
                const staticDir = path.resolve('pages/static');
                const filename = path.resolve(staticDir, sanitizer(parsedurl.pathname));
                // Compare whole path segments: a bare startsWith would let a sibling
                // such as pages/static-old/ through.
                if (filename !== staticDir && !filename.startsWith(staticDir + path.sep)) {
                    await notFound.serve404(req, res, 'Page not found.', '/', 'Back to Home');
                } else {
                    await servePage(filename, res, undefined, undefined, undefined, req);
                }
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
            if (!tokenData.access_token) {
                console.error('Discord OAuth code exchange failed:', tokenData);
                throw new Error('Discord did not accept the authorization. Please try again.');
            }
            // The token is only used for this one server-list sync and is never stored.
            accessToken = tokenData.access_token;
            tokenType = tokenData.token_type || 'Bearer';
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

            const state = query.get('state') || '';
            const returnPath = state.startsWith('return:') ? state.slice(7) : '';
            if (returnPath.startsWith('/')) {
                // toLocalPath drops anything that could make the target off-site,
                // such as the tab in "/<TAB>/evil.example" that browsers strip
                // before resolving the Location header into "//evil.example".
                res.writeHead(302, { Location: toLocalPath(returnPath, '/server/') });
                res.end();
            } else if (state === 'sync') {
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
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(
            getTemplate('generic-error', 'misc').replace(
                '{{ERROR_DETAILS}}',
                escapeHtml(e.message || 'OAuth authentication failed.')
            )
        );
    }
}

async function handleImageProxy(req, res, parsedurl, args) {
    const isFull = parsedurl.searchParams.get('full') === '1';
    if (args[2] === 'external') {
        const encodedUrl = req.url.slice(EXTERNAL_PROXY_PREFIX_LENGTH).split('?')[0];
        const fullImageUrl = Buffer.from(encodedUrl, 'base64').toString();
        await imageProxy(req, res, fullImageUrl, isFull);
    } else if (args[2] === 'sticker') {
        const stickerId = (args[3] || '').replace(/\.[^.]*$/, '');
        if (!isValidSnowflake(stickerId)) {
            await notFound.serve404(req, res, 'Page not found.', '/', 'Back to Home');
            return;
        }
        await imageProxy(
            req,
            res,
            `https://media.discordapp.net/stickers/${stickerId}.png`,
            isFull
        );
    } else if (args[2] === 'app-icon') {
        const appId = args[3];
        const iconFile = args[4] || '';
        if (!isValidSnowflake(appId) || !/^[A-Za-z0-9_]+\.[a-z]{3,4}$/.test(iconFile)) {
            await notFound.serve404(req, res, 'Page not found.', '/', 'Back to Home');
            return;
        }
        await imageProxy(
            req,
            res,
            `https://cdn.discordapp.com/app-icons/${appId}/${iconFile}`,
            isFull
        );
    } else {
        const urlObj = new URL(req.url, 'http://localhost');
        urlObj.searchParams.delete('full');
        const imagePath =
            args[2] === 'emoji' ? urlObj.pathname.slice(18) : urlObj.pathname.slice(12);
        const fullImageUrl = `https://cdn.discordapp.com/${args[2] === 'emoji' ? 'emojis' : 'attachments'}/${imagePath}${urlObj.search}`;
        await imageProxy(req, res, fullImageUrl, isFull);
    }
}

// Most error responses are short HTML fragments (e.g. "The bot isn't
// connected"). Sent bare they render as unstyled text on a white page, so any
// text/html body that isn't a full document is wrapped in the site's message
// page, keeping the header, theme and a way back.
const MESSAGE_PAGE_HEADINGS = {
    400: 'Something looks off',
    401: 'You need to log in',
    403: "You can't do that here",
    404: 'Not found',
    413: 'That was too large',
    429: 'Slow down',
    500: 'Something went wrong',
    502: 'Discord is having trouble',
    503: 'Discross is reconnecting',
};

const DEFAULT_PAGE_TITLE = 'Discross - Use Discord Anywhere';

// Pages that never name themselves still carry {$PAGE_TITLE}/{$SEO_METADATA} in
// the shared head. Only the <head> is touched, so text in the page body (such as
// a chat message) can never trigger the substitution.
function fillHeadDefaults(req, html) {
    const headEnd = html.search(/<\/head>/i);
    if (headEnd === -1) return html;
    const head = html
        .slice(0, headEnd)
        .replace('{$PAGE_TITLE}', escapeHtml(DEFAULT_PAGE_TITLE))
        .replace('{$SEO_METADATA}', () => generateSEOMetadata(req));
    return head + html.slice(headEnd);
}

function wrapHtmlFragments(req, res) {
    const originalEnd = res.end;
    res.end = function (chunk, ...rest) {
        try {
            const body = Buffer.isBuffer(chunk) ? null : chunk;
            const contentType = String(res.getHeader('Content-Type') || '');
            if (
                typeof body === 'string' &&
                body.trim() &&
                contentType.startsWith('text/html') &&
                !res.getHeader('Content-Length') &&
                !/<html[\s>]|<!doctype/i.test(body)
            ) {
                // A page can name its own heading (e.g. the 18+ gate) by setting
                // res.pageHeading before it responds.
                const heading =
                    res.pageHeading ||
                    MESSAGE_PAGE_HEADINGS[res.statusCode] ||
                    (res.statusCode >= 400 ? 'Something went wrong' : 'Discross');
                chunk = renderTemplate(messagePageTemplate, {
                    WHITE_THEME_ENABLED: getPageThemeAttr(req),
                    HEADING: heading,
                    MESSAGE: body,
                    PAGE_TITLE: `${heading} - Discross`,
                });
            }
            if (
                typeof chunk === 'string' &&
                String(res.getHeader('Content-Type') || '').startsWith('text/html') &&
                (chunk.includes('{$PAGE_TITLE}') || chunk.includes('{$SEO_METADATA}'))
            ) {
                chunk = fillHeadDefaults(req, chunk);
            }
        } catch (err) {
            console.error('Failed to wrap HTML fragment:', err);
        }
        return originalEnd.call(this, chunk, ...rest);
    };
}

// Session IDs are UUIDv4s. Anything else in a ?sessionID= parameter is dropped
// before routing so a crafted value can never be echoed back into a page.
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stripInvalidSessionParam(req) {
    if (!req.url.includes('sessionID')) return;
    const url = new URL(req.url, 'http://localhost');
    const values = url.searchParams.getAll('sessionID');
    if (values.length === 0 || (values.length === 1 && SESSION_ID_PATTERN.test(values[0]))) {
        return;
    }
    const valid = values.find((value) => SESSION_ID_PATTERN.test(value));
    url.searchParams.delete('sessionID');
    if (valid) url.searchParams.set('sessionID', valid);
    req.url = url.pathname + url.search;
}

server.on('request', async (req, res) => {
    // Security headers applied to every response. Set via setHeader (not
    // writeHead) so they persist through the many writeHead calls downstream.
    // Referrer-Policy is the important one here: sessions can ride in the URL
    // (?sessionID=…) for cookieless legacy consoles, so we must never leak the
    // full URL in the Referer header to external images/links.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Pages are only ever framed by Discross itself (webapp.html, the OAuth
    // sync iframe), so refuse cross-origin framing to prevent clickjacking.
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // The pages rely on inline scripts and styles for legacy-console support, so
    // this can't restrict script sources. It still stops injected markup from
    // re-pointing <base>, posting forms off-site or framing the site elsewhere.
    res.setHeader(
        'Content-Security-Policy',
        "base-uri 'self'; form-action 'self'; frame-ancestors 'self'"
    );
    wrapHtmlFragments(req, res);

    if (req.url.startsWith('//')) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(getTemplate('invalid-request-url', 'misc'));
        return;
    }

    try {
        stripInvalidSessionParam(req);
    } catch {
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
        console.error(`Port ${PORT} is already in use. Failed to start server.`);
        process.exit(1);
    } else {
        console.error('Server error:', err);
    }
});

bot.startBot().catch((err) => {
    console.error('Discord bot failed to start:', err.message);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
    console.log(`Discross running on port ${PORT}`);
});
