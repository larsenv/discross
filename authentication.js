const bcrypt = require('bcrypt')
const sqlite3 = require('better-sqlite3')
const { v4: uuidv4 } = require('uuid')
const { parse } = require('querystring')
const passStrength = require('owasp-password-strength-test')
const he = require('he') // Encodes HTML attributes

passStrength.config({
  minLength: 8
})

const saltRounds = 10
const expiryTime = 24 * 60 * 60 // For sessions - expires in 24 hours
const codeExpiryTime = 30 * 60 // For verification codes - expires in 30 minutes

let https = true // Just to make sure - determines whether cookies have the Secure; option

exports.setHTTPS = function (ishttps) { // Called from index.js
  https = ishttps
}

const db = new sqlite3('secrets/database.db');
console.log("Connected to the database.");

function queryRun(sql, params = []) {
  return db.prepare(sql).run(...params);
}

function querySingle(sql, params = []) {
  return db.prepare(sql).get(...params);
}

function queryAll(sql, params = []) {
  return db.prepare(sql).all(...params);
}

//for the oauth thing
exports.insertServers = function (items) {
  const serversQuery = db.prepare("INSERT OR IGNORE INTO servers VALUES (@serverID, @discordID)");
  const transaction = db.transaction(function (items) {
    for (const item of items) serversQuery.run(item);
  });
  return transaction(items);
};

function unixTime() {
  return Math.floor(new Date() / 1000)
}

exports.createUser = async function (discordID, username, password) {
  let match = querySingle('SELECT DISTINCT * FROM users WHERE username=?', [username])
  if (match) {
    return { status: 'error', reason: 'An account with that username exists!' }
  }
  match = querySingle('SELECT DISTINCT * FROM users WHERE discordID=?', [discordID])
  if (match) {
    return { status: 'error', reason: "There's already an account linked to that Discord account!\nTry resetting your password on the login page." }
  }
  const tested = passStrength.test(password)
  if (tested.strong) {
    const hashedPassword = await bcrypt.hash(password, saltRounds)
    queryRun('INSERT INTO users VALUES (?,?,?)', [discordID, username, hashedPassword])
    return { status: 'success' }
  } else {
    return { status: 'error', reason: tested.errors.join('\n') }
  }
}

exports.login = async function (username, password) {
  const match = querySingle('SELECT DISTINCT * FROM users WHERE username=?', [username])
  if (!match) {
    return { status: 'error', reason: "That account doesn't exist!" }
  } else {
    const correctPassword = await bcrypt.compare(password, match.hashedPassword)
    if (correctPassword) {
      const sessionID = uuidv4()
      const expiresAt = unixTime() + expiryTime
      queryRun('INSERT INTO sessions VALUES (?,?,?)', [match.discordID, sessionID, unixTime() + expiryTime])
      return { status: 'success', sessionID: sessionID, expires: expiresAt }
    } else {
      return { status: 'error', reason: 'Incorrect password!' }
    }
  }
}

exports.checkSession = async function (sessionID) {
  const time = unixTime()
  queryRun('DELETE FROM sessions WHERE NOT expires > ?', [time]) // Clean the database (not awaited because it's not urgent)
  const match = querySingle('SELECT DISTINCT * FROM sessions WHERE sessionID=? AND expires > ?', [sessionID, time])
  if (!match) {
    return false
  } else {
    if (exports.getUsername(match.discordID)) { // Check if user exists
      return match.discordID
    } else {
      return false
    }
  }
}

exports.logout = async function (discordID) {
  //if (typeof discordID == "object") return;
  queryRun('DELETE FROM sessions WHERE discordID=?', [discordID])
}

exports.getUsername = async function (discordID) {
  if (typeof discordID === "object") return discordID[1]
  const match = querySingle('SELECT DISTINCT username FROM users WHERE discordID=?', [discordID])
  if (match) {
    return match.username
  } else {
    return false
  }
}

exports.createVerificationCode = async function (discordID) {
  const time = unixTime()
  queryRun('DELETE FROM verificationcodes WHERE NOT expires > ?', [time]) // Clean the database (not awaited because it's not urgent)
  const match = querySingle('SELECT DISTINCT code FROM verificationcodes WHERE discordID=? AND expires > ?', [discordID, time])
  if (match) {
    return match.code
  } else {
    const generatedCode = uuidv4().slice(0, 8) + 'a' + uuidv4().slice(9, 10) // Puts an "a" into it so it isn't stored as a number. I know that this makes 2 UUIDs.
    queryRun('INSERT INTO verificationcodes VALUES (?,?,?)', [discordID, generatedCode, time + codeExpiryTime])
    return generatedCode
  }
}

exports.checkVerificationCode = async function (code) {
  const time = unixTime()
  queryRun('DELETE FROM verificationcodes WHERE NOT expires > ?', [time]) // Clean the database (not awaited because it's not urgent)
  const match = querySingle('SELECT DISTINCT discordID FROM verificationcodes WHERE code=? AND expires > ?', [code, time])
  if (match) {
    return match.discordID
  } else {
    return false
  }
}

function setup() {
  queryRun('CREATE TABLE IF NOT EXISTS users (discordID TEXT, username STRING, hashedPassword STRING)')
  queryRun('CREATE TABLE IF NOT EXISTS sessions (discordID TEXT, sessionID STRING, expires INT)')
  queryRun('CREATE TABLE IF NOT EXISTS webhooks (serverID TEXT, webhookID TEXT, token STRING)')
  queryRun('CREATE TABLE IF NOT EXISTS verificationcodes (discordID TEXT, code STRING, expires INT)')
  queryRun('CREATE TABLE IF NOT EXISTS servers (serverID TEXT, discordID TEXT, unique (serverID, discordID))')
}

setup();

exports.checkAuth = async function (req, res, noRedirect) {
  const cookies = req.headers.cookie

  const cookiedict = {} // https://stackoverflow.com/questions/3393854/get-and-set-a-single-cookie-with-node-js-http-server

  cookies && cookies.split(';').forEach(function (cookie) {
    var parts = cookie.split('=')
    cookiedict[parts.shift().trim()] = decodeURI(parts.join('='))
  })

  if (cookiedict.sessionID) {
    /*if (cookiedict.sessionID === 'guest') {
      return ['guest', cookiedict.guestUsername]
    } else {*/
    const session = await exports.checkSession(cookiedict.sessionID)
    if (session) {
      return session
    } else {
      if (!noRedirect) {
        res.writeHead(301, { Location: '/login.html?redirect=' + encodeURIComponent(req.url) })
        res.end()
      }
      return false
    }
    //}
  } else {
    if (!noRedirect) {
      res.writeHead(303, { Location: '/login.html?redirect=' + encodeURIComponent(req.url) })
      res.end()
    }
    return false
  }
}

exports.handleLoginRegister = async function (req, res, body) {
  if (req.url === '/login') {
    const params = parse(body)
    if (params.username && params.password) {
      const result = await exports.login(params.username, params.password)
      if (result.status === 'success') {
        if (params.redirect) {
          res.writeHead(200, { 'Set-Cookie': ['sessionID=' + result.sessionID + '; Expires=' + new Date(result.expires * 1000) + '; path=/;'], Location: params.redirect + '#end', 'Content-Type': 'text/html' })
          res.write('<head><meta http-equiv="refresh" content="0; URL=' + he.encode(params.redirect) + '" />' + 'Logged in. Click <a href="discross.rc24.xyz' + he.encode(params.redirect) + '">here</a> to continue</head>')
        } else {
          res.writeHead(200, { 'Set-Cookie': ['sessionID=' + result.sessionID + '; Expires=' + new Date(result.expires * 1000) + '; path=/;'], Location: '/server/' + '#end', 'Content-Type': 'text/html' })
          res.write('<head><meta http-equiv="refresh" content="0; URL=discross.rc24.xyz/server/" />' + 'Logged in. Click <a href="discross.rc24.xyz/server/">here</a> to continue</head>')
        }
        res.end()
      } else {
        res.writeHead(301, { Location: '/login.html?errortext=' + encodeURIComponent(result.reason), 'Content-Type': 'text/html' })
        res.end()
      }
    }
  } /*else if (req.url === '/guest') {
    const params = parse(body)
    if (params.username !== '') {
      res.writeHead(303, { 'Set-Cookie': ['guestUsername=' + encodeURIComponent(params.username), 'sessionID=guest; SameSite=Strict; ' + (https ? 'Secure;' : '')], Location: '/server/', 'Content-Type': 'text/html' })
      res.write('Logged as a guest! Click <a href="/server/">here</a> to continue.')
    } else {
      res.writeHead(303, { Location: '/guest.html?errortext=Please+input+a+username', 'Content-Type': 'text/html' })
      res.write('Please input a username')
      res.end()
    }
  } */else if (req.url === '/register') {
    const params = parse(body)
    if (params.username && params.password && params.confirm && params.token) {
      if (params.confirm !== params.password) {
        res.writeHead(301, { Location: "/register.html?errortext=Password+confirmation+doesn't+match+password!", 'Content-Type': 'text/html' })
        res.end()
        return
      }
      const id = await exports.checkVerificationCode(params.token)
      if (!id) {
        res.writeHead(301, { Location: '/register.html?errortext=Invalid+verification+code!%0AType+%5Econnect+on+a+server+with+the+Discross+bot.', 'Content-Type': 'text/html' })
        res.end()
        return
      }
      const result = await exports.createUser(id, params.username, params.password)
      if (result.status === 'success') {
        res.writeHead(301, { Location: '/login.html' })
        res.end()
      } else {
        res.writeHead(301, { Location: '/register.html?errortext=' + encodeURIComponent(result.reason) })
        res.end()
      }
    } else {
      res.writeHead(303, { Location: '/register.html?errortext=Please+fill+in+all+boxes!' })
      res.end()
    }
  } else if (req.url === '/forgot') {
    const params = parse(body)
    if (params.token) {
      const id = await exports.checkVerificationCode(params.token)
      if (!id) {
        res.writeHead(301, { Location: '/forgot.html?errortext=Invalid+verification+code!%0AType+%5Econnect+on+a+server+with+the+Discross+bot.' })
        res.end()
        return
      }
      queryRun('DELETE FROM users WHERE discordID = ?', [id])
      queryRun('DELETE FROM sessions WHERE discordID = ?', [id])
      queryRun('DELETE FROM verificationcodes WHERE discordID = ?', [id])
      queryRun('DELETE FROM servers WHERE discordID = ?', [id])
      res.writeHead(303, { Location: '/register.html' })
      res.end()
    } else {
      res.writeHead(303, { Location: '/forgot.html?errortext=Please+fill+the+code!' })
      res.end()
    }
  }
}

exports.dbQueryRun = queryRun

exports.dbQuerySingle = querySingle

exports.dbQueryAll = queryAll
