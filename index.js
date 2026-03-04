require('./instrument.js')
require('dotenv').config({ quiet: true })
const path = require('path')
const fs = require('fs')
const querystring = require('querystring')
const mime = require('mime-types').lookup
const { SnowTransfer } = require('snowtransfer')
const bot = require('./bot.js')
const connectionHandler = require('./connectionHandler.js')
const sharp = require("sharp")
const sanitizer = require("path-sanitizer").default;
const Sentry = require("@sentry/node");

const options = {}

const sentryEnabled = !!process.env.SENTRY_DSN;

process.on("unhandledRejection", (err) => {
  console.log(err);
  if (sentryEnabled) Sentry.captureException(err);
});

process.on("uncaughtException", (err) => {
  console.error(err);
  if (sentryEnabled) {
    Sentry.captureException(err);
    Sentry.flush(2000).finally(() => process.exit(1));
  } else {
    process.exit(1);
  }
});

try { // Use HTTPS if keys are available
  options.key = fs.readFileSync('secrets/key.pem')
  options.cert = fs.readFileSync('secrets/cert.pem')
  console.log('Found keys - using HTTPS!')
} catch (err) {
  console.log('No keys found - using HTTP!')
}

const usinghttps = !!options.key
const http = usinghttps ? require('https') : require('http')

const auth = require('./authentication.js')
auth.setHTTPS(usinghttps) // Determines whether cookies have the Secure; option

const indexpage = require('./pages/index.js');
const loginpage = require('./pages/login.js');
const registerpage = require('./pages/register.js');
const forgotpage = require('./pages/forgot.js');
const channelpage = require('./pages/channel.js');
const serverpage = require('./pages/server.js');
const sendpage = require('./pages/send.js');
const { toggleTheme } = require('./pages/themeToggle.js')
const { imageProxy } = require('./pages/imageProxy.js')
const { fileProxy } = require('./pages/fileProxy.js')
const { toggleImages } = require('./pages/toggleImages.js')
const { uploadFile } = require('./pages/uploadFile.js')
const uploadpage = require('./pages/upload.js')
const chanelreplypage = require('./pages/channel_reply.js')
const replypage = require('./pages/reply.js')
const drawpage = require('./pages/draw.js')
const senddrawing = require('./pages/senddrawing.js')
const { handleServerIcon } = require('./pages/serverIconHandler.js')
const pinspage = require('./pages/pins.js')
const changepasswordpage = require('./pages/changepassword.js')
const setup2fapage = require('./pages/setup2fa.js')
const privacypage = require('./pages/privacy.js')
const termspage = require('./pages/terms.js')
const foodpage = require('./pages/food.js')
const weatherpage = require('./pages/weather.js')

// Constants for imageProxy path lengths
const EXTERNAL_PROXY_PREFIX_LENGTH = '/imageProxy/external/'.length; // 21
const STICKER_PROXY_PREFIX_LENGTH = '/imageProxy/sticker/'.length; // 20


bot.startBot();

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || '')
}
// https://stackoverflow.com/questions/1967119/why-does-javascript-replace-only-first-instance-when-using-replace

// create a server object:
const server = http.createServer(options)
connectionHandler.startWsServer(server)

// In-memory cache for static files served via servePage()
const staticFileCache = new Map();
const STATIC_CACHE_MAX_FILES = 2000;    // max distinct files to cache (FIFO eviction)
const STATIC_CACHE_MAX_BYTES = 1024 * 1024; // skip caching individual files larger than 1 MB

async function servePage(filename, res, type, textToReplace, replacement) { // textToReplace and replacement allow for dynamic pages (not used anymore as far as I know)
  if (!type) {
    type = mime(filename)
  }
  if (filename.endsWith('/')) {
    filename += 'index.html'
  }

  // Serve from in-memory cache for plain (non-templated) requests
  if (!textToReplace && staticFileCache.has(filename)) {
    const data = staticFileCache.get(filename)
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' })
    res.write(data)
    return res.end()
  }

  fs.readFile(filename, function (err, data) {
    if (err) {
      //try to find something
      if (filename.endsWith('index.html')) {
        res.writeHead(404, { 'Content-Type': type })
        return res.end('404 Not Found')
      } else {
        servePage(filename + '/index.html', res)
        return
      }
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' })
    if (textToReplace && replacement) {
      res.write(data.toString().replace(textToReplace, replacement))
    } else {
      if (data.length <= STATIC_CACHE_MAX_BYTES) {
        if (staticFileCache.size >= STATIC_CACHE_MAX_FILES) {
          staticFileCache.delete(staticFileCache.keys().next().value)
        }
        staticFileCache.set(filename, data)
      }
      res.write(data)
    }
    return res.end()
  })
}

async function senddrawingAsync(req, res, body) {
  const discordID = await auth.checkAuth(req, res)
  
  // Validate body is not empty
  if (!body || body.trim() === '') {
    console.error('Error: senddrawingAsync received empty body');
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('No data received');
    return;
  }
  
  // Use querystring module to handle large base64 data
  const urlQuery = querystring.parse(body);
  
  if (!urlQuery || !urlQuery.drawinginput) {
    console.error('Error: senddrawingAsync - drawinginput not found in parsed URL query');
    console.error('Body length:', body.length);
    console.error('Query keys:', Object.keys(urlQuery || {}));
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid drawing data');
    return;
  }
  
  if (discordID) {
    await senddrawing.sendDrawing(bot, req, res, [], discordID, urlQuery)
  }
}

server.on('request', async (req, res) => {
  if (req.method === 'POST') {
    const parsedurl = new URL(req.url, 'http://localhost').pathname;
    
    // Handle file upload BEFORE reading body (formidable needs raw stream)
    if (parsedurl == "/uploadFile") {
      // Set high timeout for file uploads (15 minutes = 15 * 60 * 1000 ms)
      req.setTimeout(15 * 60 * 1000);
      res.setTimeout(15 * 60 * 1000);
      
      (async () => {
        const discordID = await auth.checkAuth(req, res, true);
        if (discordID) {
          await uploadFile(bot, req, res, [], discordID);
        }
      })().catch((err) => {
        console.log(err);
        if (sentryEnabled) Sentry.captureException(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Internal Server Error' }));
      });
      return; // Don't read body for file uploads
    }
    
    // For all other POST requests, read the body
    let body = '' // https://itnext.io/how-to-handle-the-post-request-body-in-node-js-without-using-a-framework-cd2038b93190
    req.on('data', chunk => {
      body += chunk.toString() // convert Buffer to string
    })
    req.on('error', (err) => {
      console.error('Error reading request body:', err);
      if (sentryEnabled) Sentry.captureException(err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error reading request data');
      }
    })
    req.on('end', () => {
      if (parsedurl == "/toggleCategory") {
        // Handle category toggle
        (async () => {
          const discordID = await auth.checkAuth(req, res, true)
          if (discordID) {
            try {
              const data = JSON.parse(body)
              const { serverID, categoryID, collapsed } = data
              const result = auth.setChannelPreference(discordID, serverID, categoryID, collapsed ? 1 : 0)
              if (result.success) {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: true }))
              } else {
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: false, error: result.error }))
              }
            } catch (err) {
              console.error('Error toggling category:', err)
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, error: err.message }))
            }
          } else {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'Not authenticated' }))
          }
        })()
      } else if (parsedurl == "/senddrawing") {
        senddrawingAsync(req, res, body).then(() => {}).catch((err) => {
          console.log(err)
          if (sentryEnabled) Sentry.captureException(err);
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end('Internal Server Error')
        }
        )
      } else if (parsedurl == "/changepassword") {
        (async () => {
          const discordID = await auth.checkAuth(req, res, true)
          if (discordID) {
            await changepasswordpage.handleChangePassword(bot, req, res, body, discordID)
          } else {
            res.writeHead(302, { Location: '/login.html' })
            res.end()
          }
        })().catch((err) => {
          console.error(err)
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end('Internal Server Error')
        })
      } else if (parsedurl == "/setup2fa") {
        (async () => {
          const discordID = await auth.checkAuth(req, res, true)
          if (discordID) {
            await setup2fapage.handleSetup2FA(bot, req, res, body, discordID)
          } else {
            res.writeHead(302, { Location: '/login.html' })
            res.end()
          }
        })().catch((err) => {
          console.error(err)
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end('Internal Server Error')
        })
      } else if (parsedurl == "/disable2fa") {
        (async () => {
          const discordID = await auth.checkAuth(req, res, true)
          if (discordID) {
            await setup2fapage.handleDisable2FA(bot, req, res, body, discordID)
          } else {
            res.writeHead(302, { Location: '/login.html' })
            res.end()
          }
        })().catch((err) => {
          console.error(err)
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end('Internal Server Error')
        })
      } else if (parsedurl.startsWith('/food/')) {
        (async () => {
          const discordID = await auth.checkAuth(req, res)
          if (discordID) {
            await foodpage.handlePost(bot, req, res, discordID, body)
          }
        })().catch((err) => {
          console.error(err)
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' })
            res.end('Internal Server Error')
          }
        })
      } else {
        auth.handleLoginRegister(req, res, body)
      }
    })
  } else {
    try {

    const parsedurl = new URL(req.url, 'http://localhost')
    const args = strReplace(parsedurl.pathname, '?', '/').split('/') // Split by / or ?
    if (args[1] === 'send') {
      const discordID = await auth.checkAuth(req, res)
      if (discordID) {
        await sendpage.sendMessage(bot, req, res, args, discordID)
      }
    } else if (args[1] === 'reply') {
      const discordID = await auth.checkAuth(req, res)
      if (discordID) {
        await replypage.replyMessage(bot, req, res, args, discordID)
      }
    } else if (args[1] === 'switchtheme') {
      toggleTheme(req, res)
    } else if (args[1] === 'toggleImages') {
      toggleImages(req, res)
    } else if (args[1] === 'logout') {
      const discordID = await auth.checkAuth(req, res, true) // True = no redirect to login page
      if (discordID) {
        auth.logout(discordID)
      }
      res.writeHead(302, { Location: '/' })
      res.end()
    } else if (parsedurl.pathname === '/toggleAnimations') {
      toggleAnimations(req, res)
    } else if (args[1] === 'server') {
      const discordID = await auth.checkAuth(req, res)
      if (discordID) {
        await serverpage.processServer(bot, req, res, args, discordID)
      }
    } else if (args[1] === 'channels') {
      const discordID = await auth.checkAuth(req, res)
      if (args.length == 3) {
        if (discordID) {
          await channelpage.processChannel(bot, req, res, args, discordID)
        }
      }
      else if (args.length == 4) {
        if (discordID) {
          if (args[3].length == 0) {
            res.writeHead(302, { "Location": `/channels/${args[2]}#end` });
            res.end();
            return;
          } else { await chanelreplypage.processChannelReply(bot, req, res, args, discordID) }
        }
      } else {
        if (discordID) {
          res.writeHead(302, { "Location": `/channels/${args[2]}#end` });
          res.end();
          return;
        }
      }
    } else if (args[1] === "jobs"){
      res.writeHead(302, { "Location": "http://careers.mcdonalds.com/" });
      res.end();
      return;
    } else if (args[1] === 'upload') {
      const discordID = await auth.checkAuth(req, res)
      if (discordID) {
        await uploadpage.processUpload(bot, req, res, discordID)
      }
    } else if (args[1] === 'pins') {
      const discordID = await auth.checkAuth(req, res)
      if (discordID) {
        await pinspage.processPins(bot, req, res, args, discordID)
      }
    } else if (args[1] === 'draw'){
      const discordID = await auth.checkAuth(req, res)
      if (discordID) {
        await drawpage.processDraw(bot, req, res, args, discordID)
      }
    } else if (args[1] === 'login.html') {
      await loginpage.processLogin(bot, req, res, args)
    } else if (args[1] === 'register.html') {
      await registerpage.processRegister(bot, req, res, args)
    } else if (args[1] === 'forgot.html') {
      await forgotpage.processForgot(bot, req, res, args)
    } else if (args[1] === 'changepassword.html') {
      await changepasswordpage.processChangePassword(bot, req, res, args)
    } else if (args[1] === 'food') {
      const discordID = await auth.checkAuth(req, res)
      if (discordID) {
        await foodpage.handleGet(bot, req, res, discordID)
      }
    } else if (args[1] === 'foodProxy') {
      await foodpage.foodProxy(req, res)
    } else if (args[1] === 'setup2fa.html') {
      await setup2fapage.processSetup2FA(bot, req, res, args)
    } else if (args[1] === 'index.html' || parsedurl.pathname === '/') {
      await indexpage.processIndex(bot, req, res, args)
    } else if (args[1] === 'privacy.html') {
      await privacypage.processPrivacy(bot, req, res, args)
    } else if (args[1] === 'terms.html') {
      await termspage.processTerms(bot, req, res, args)
    } else if (args[1] === 'weather') {
      await weatherpage.processWeather(req, res)
    } else if (args[1] === 'longpoll.js' || args[1] === 'longpoll-xhr' || args[1] === 'api.js') { // Connection
      connectionHandler.processRequest(req, res)
    } else if (args[1] === "discord") {
      const discordID = await auth.checkAuth(req, res);
      if (discordID) {
        try {
          const query = new URLSearchParams(req.url.split("?")[1]);
          const oauthClient = new SnowTransfer(`${query.get("token_type")} ${query.get("access_token")}`);
          const user = await oauthClient.user.getSelf();
          if (user && (user.id === discordID)) {
            const guilds = await oauthClient.user.getGuilds();
            const filteredServers = guilds.filter(e => bot.client.guilds.cache.has(e.id));
            const readyServers = filteredServers.map(function (e) {
              return { serverID: e.id, discordID: discordID, icon: e.icon }
            });
            //insert onto sqlite
            auth.insertServers(readyServers);
            //GIFs
            for (const server of readyServers) {
              if (server.icon) {
                await fs.promises.mkdir(path.resolve(`pages/static/ico/server`, sanitizer(server.serverID)), { recursive: true });
                if (server.icon.startsWith("a_")) {
                  fs.promises.writeFile(path.resolve(`pages/static/ico/server`, sanitizer(`${server.serverID}/${server.icon.substring(2)}.gif`)), Buffer.from(await (await fetch(`https://cdn.discordapp.com/icons/${server.serverID}/${server.icon}.gif?size=128`)).arrayBuffer()));
                } else {
                  await sharp(await (await fetch(`https://cdn.discordapp.com/icons/${server.serverID}/${server.icon}.png?size=128`)).arrayBuffer()).toFile(path.resolve(`pages/static/ico/server/`, sanitizer(`${server.serverID}/${server.icon}.gif`)))
                }
              }
            }
            res.writeHead(302, { Location: "/server/" });
            res.write("");
            res.end();
          } else {
            res.writeHead(302, { Location: "/" });
            res.write("");
            res.end();
          }
        } catch {
          res.writeHead(302, { Location: "/" });
          res.write("");
          res.end();
        }
      }
    } else if (args[1] === 'imageProxy') {
      // Handle different types of image proxy requests
      if (args[2] === 'external') {
        // External URLs are base64-encoded in args[3]
        const encodedUrl = req.url.slice(EXTERNAL_PROXY_PREFIX_LENGTH);
        const fullImageUrl = Buffer.from(encodedUrl, 'base64').toString();
        await imageProxy(res, fullImageUrl);
      } else if (args[2] === 'sticker') {
        // Sticker URLs: /imageProxy/sticker/{stickerId}.{format}
        const stickerPath = req.url.slice(STICKER_PROXY_PREFIX_LENGTH);
        const fullImageUrl = `https://cdn.discordapp.com/stickers/${stickerPath}`;
        await imageProxy(res, fullImageUrl);
      } else {
        // Emoji and attachment URLs
        const fullImageUrl = `https://cdn.discordapp.com/${args[2] == "emoji" ? "emojis" : "attachments"}/${args[2] == "emoji" ? req.url.slice(18) : req.url.slice(12)}`
        await imageProxy(res, fullImageUrl);
      }
    } else if (args[1] === 'fileProxy') {
      const filePath = req.url.slice(11)
      const fullFileUrl = `https://cdn.discordapp.com/attachments/${filePath}`
      await fileProxy(res, fullFileUrl);
    } else if (args[1] === 'ico' && args[2] === 'server' && args[3] && args[4]) {
      // Handle server icon requests: /ico/server/{serverID}/{iconHash}.gif
      const discordID = await auth.checkAuth(req, res, true); // Don't redirect if not authenticated
      const serverID = args[3];
      const iconFilename = args[4];
      const iconHash = iconFilename.replace('.gif', '');
      
      // Determine theme from URL param (takes priority) or cookie
      let theme = 'dark';
      if (discordID) {
        const urlTheme = parsedurl.searchParams.get('theme');
        const whiteThemeCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('whiteThemeCookie='))?.split('=')[1];
        const themeValue = urlTheme !== null ? urlTheme : whiteThemeCookie;
        if (themeValue === '1') {
          theme = 'light';
        } else if (themeValue === '2') {
          theme = 'amoled';
        }
      }
      
      await handleServerIcon(bot, res, serverID, iconHash, theme);
    } else {
      const filename = path.resolve("pages/static", sanitizer(parsedurl.pathname));
      await servePage(filename, res)
    }
    } catch (err) {
      console.error(err);
      if (sentryEnabled) Sentry.captureException(err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
    }
  }
})

server.listen(4000)
