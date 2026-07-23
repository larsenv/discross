'use strict';
/**
 * Authentication module for Discross.
 * Handles user accounts, sessions, and Discord integration.
 */
const bcrypt = require('bcrypt');
const sqlite3 = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const he = require('he'); // Encodes HTML attributes
const otplib = require('otplib');
const qrcode = require('qrcode');
const crypto = require('crypto');
const webauthn = require('./webauthn');
const { getTemplate, renderTemplate } = require('../pages/utils');

// --- WebAuthn challenge store ------------------------------------------------
// Passkey ceremonies are two requests (options → verify). We must remember the
// server-issued challenge in between and allow it exactly once, or an attacker
// could replay a captured assertion. Kept in-memory (single process) keyed by
// the base64url challenge; entries expire after 5 minutes.
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const _passkeyChallenges = new Map();

function storePasskeyChallenge(challengeB64url, meta) {
    // Opportunistic cleanup of expired challenges.
    const now = Date.now();
    for (const [key, val] of _passkeyChallenges) {
        if (val.expires <= now) _passkeyChallenges.delete(key);
    }
    _passkeyChallenges.set(challengeB64url, { ...meta, expires: now + CHALLENGE_TTL_MS });
}

// Look up and CONSUME a challenge (single use). Returns the metadata or null.
function consumePasskeyChallenge(challengeB64url) {
    const entry = _passkeyChallenges.get(challengeB64url);
    if (!entry) return null;
    _passkeyChallenges.delete(challengeB64url);
    if (entry.expires <= Date.now()) return null;
    return entry;
}

// --- Configuration & Constants ---

const saltRounds = 10;
// A fixed bcrypt hash compared against on the "no such user" login path so that
// login timing (and thus username existence) can't be trivially distinguished.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('discross-dummy-password', saltRounds);
const expiryTime = 7 * 24 * 60 * 60; // For sessions - expires in 7 days
const codeExpiryTime = 30 * 60; // For verification codes - expires in 30 minutes
const pendingTotpExpiryTime = 10 * 60; // Pending TOTP setup expires in 10 minutes
const actionCodeExpiryTime = 10 * 60; // In-session action codes expire in 10 minutes

let https = true; // Determines whether cookies have the Secure; option

/**
 * Called from index.js to set the HTTPS state for cookies.
 * @param {boolean} ishttps
 */
exports.setHTTPS = function (ishttps) {
    https = ishttps;
};

// --- Database Setup & Helpers ---

const db = new sqlite3('db/discross.db');
console.info('Connected to the database.');

function queryRun(sql, params = []) {
    return db.prepare(sql).run(...params);
}

function querySingle(sql, params = []) {
    return db.prepare(sql).get(...params);
}

function queryAll(sql, params = []) {
    return db.prepare(sql).all(...params);
}

function unixTime() {
    return Math.floor(new Date() / 1000);
}

function setup() {
    queryRun(
        'CREATE TABLE IF NOT EXISTS users (discordID TEXT, username STRING, hashedPassword STRING)'
    );
    // Add totp_secret column if it doesn't exist (migration for existing installs)
    try {
        queryRun('ALTER TABLE users ADD COLUMN totp_secret TEXT');
    } catch (_) {}
    try {
        queryRun('ALTER TABLE users ADD COLUMN discord_access_token TEXT');
        queryRun('ALTER TABLE users ADD COLUMN discord_refresh_token TEXT');
        queryRun('ALTER TABLE users ADD COLUMN discord_token_expires INTEGER');
    } catch (_) {}
    queryRun('CREATE TABLE IF NOT EXISTS sessions (discordID TEXT, sessionID STRING, expires INT)');
    queryRun('CREATE TABLE IF NOT EXISTS webhooks (serverID TEXT, webhookID TEXT, token STRING)');
    queryRun(
        'CREATE TABLE IF NOT EXISTS verificationcodes (discordID TEXT, code STRING, expires INT)'
    );
    queryRun(
        'CREATE TABLE IF NOT EXISTS servers (serverID TEXT, discordID TEXT, unique (serverID, discordID))'
    );
    queryRun(
        'CREATE TABLE IF NOT EXISTS channel_preferences (discordID TEXT, serverID TEXT, channelID TEXT, collapsed INTEGER DEFAULT 0, PRIMARY KEY (discordID, serverID, channelID))'
    );
    queryRun(
        'CREATE TABLE IF NOT EXISTS pending_totp (discordID TEXT PRIMARY KEY, secret TEXT, expires INT)'
    );
    queryRun(
        'CREATE TABLE IF NOT EXISTS backup_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, discordID TEXT, code_hash TEXT)'
    );
    queryRun(
        'CREATE TABLE IF NOT EXISTS action_codes (discordID TEXT, action TEXT, code TEXT, expires INT, PRIMARY KEY (discordID, action))'
    );
    queryRun(
        'CREATE TABLE IF NOT EXISTS emoji_cache (emoji_key TEXT PRIMARY KEY, twemoji_code TEXT)'
    );
    // One-time migration: clear emoji_cache to fix stale entries that used the
    // incorrect fe0f-including codes (e.g. #️⃣ → "23-fe0f-20e3" instead of "23-20e3").
    try {
        queryRun('CREATE TABLE emoji_cache_cleared_v1 (done INTEGER)');
        try {
            queryRun('DELETE FROM emoji_cache');
        } catch (err) {
            console.error('emoji_cache migration error:', err);
        }
    } catch {
        // Migration already ran
    }
    queryRun(
        'CREATE TABLE IF NOT EXISTS custom_emoji_cache (emoji_id TEXT PRIMARY KEY, emoji_name TEXT, animated INTEGER)'
    );
    queryRun('CREATE TABLE IF NOT EXISTS guest_channels (channelID TEXT PRIMARY KEY)');
    queryRun(
        'CREATE TABLE IF NOT EXISTS passkeys (discordID TEXT, credentialID TEXT PRIMARY KEY, publicKey BLOB, counter INTEGER DEFAULT 0)'
    );
    // One-time migration: earlier builds never verified passkeys and stored the
    // credential ID in the `publicKey` column instead of the real public key, so
    // those rows can't be used for signature verification. Clear them once so
    // affected users simply re-register a working passkey.
    try {
        queryRun('CREATE TABLE passkeys_pubkey_migration_v1 (done INTEGER)');
        try {
            queryRun('DELETE FROM passkeys');
        } catch (err) {
            console.error('passkeys migration error:', err);
        }
    } catch {
        // Migration already ran
    }
    queryRun(
        'CREATE TABLE IF NOT EXISTS message_user_agents (messageID TEXT PRIMARY KEY, userAgent TEXT)'
    );

    // DM Email System tables
    queryRun(
        'CREATE TABLE IF NOT EXISTS mail_users (discordID TEXT PRIMARY KEY, email_prefix TEXT UNIQUE, active INTEGER DEFAULT 1)'
    );
    queryRun(
        'CREATE TABLE IF NOT EXISTS mail_verifications (discordID TEXT PRIMARY KEY, code TEXT, email_prefix TEXT, backup_email TEXT, expires INT)'
    );
    queryRun(
        'CREATE TABLE IF NOT EXISTS mail_blocks (discordID TEXT, blocked_email TEXT, PRIMARY KEY(discordID, blocked_email))'
    );
}

setup();

// Pre-compiled statements for the hot path
const _stmtDeleteExpiredSessions = db.prepare('DELETE FROM sessions WHERE expires <= ?');
const _stmtGetSessionWithUser = db.prepare(
    'SELECT s.discordID FROM sessions s INNER JOIN users u ON u.discordID = s.discordID WHERE s.sessionID = ? AND s.expires > ?'
);
let _lastSessionCleanup = 0;

// --- Rate limiting for brute-forceable secrets -------------------------------
// Login passwords/2FA and the short numeric verification codes (action codes,
// mail codes) are otherwise guessable by repeated submission — a 6-digit code
// is only 10^6 possibilities. We track consecutive *failures* per key in-memory
// and block once a threshold is hit within a rolling window; a success clears
// the counter. Keyed by account/action, not by IP, so it can't be bypassed by
// rotating source addresses (and legacy consoles behind shared NAT aren't
// collectively locked out by one bad actor).
const _failBuckets = new Map(); // key -> { count, resetAt }

function isRateLimited(key, maxFails) {
    const bucket = _failBuckets.get(key);
    return !!bucket && bucket.resetAt > Date.now() && bucket.count >= maxFails;
}

function registerFailure(key, windowMs) {
    const now = Date.now();
    const bucket = _failBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
        _failBuckets.set(key, { count: 1, resetAt: now + windowMs });
    } else {
        bucket.count += 1;
    }
}

function clearFailures(key) {
    _failBuckets.delete(key);
}

// Periodically drop expired buckets so the map can't grow unbounded.
setInterval(
    () => {
        const now = Date.now();
        for (const [key, bucket] of _failBuckets) {
            if (bucket.resetAt <= now) _failBuckets.delete(key);
        }
    },
    10 * 60 * 1000
).unref();

const LOGIN_MAX_FAILS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const CODE_MAX_FAILS = 5;
const CODE_WINDOW_MS = 10 * 60 * 1000;

// --- Validation Helpers ---

function validatePassword(password) {
    const errors = [];
    if (!password || password.length < 7) {
        errors.push('The password must be at least 7 characters long.');
    }
    if (!/[A-Z]/.test(password)) {
        errors.push('The password must contain at least one uppercase letter.');
    }
    if (!/[a-z]/.test(password)) {
        errors.push('The password must contain at least one lowercase letter.');
    }
    if (!/[0-9]/.test(password)) {
        errors.push('The password must contain at least one number.');
    }
    return { strong: errors.length === 0, errors };
}

function validateUsername(username) {
    const errors = [];
    if (!username || username.length < 3) {
        errors.push('The username must be at least 3 characters long.');
    }
    if (username && username.length > 32) {
        errors.push('The username must be at most 32 characters long.');
    }
    if (!/^[a-zA-Z0-9._]+$/.test(username)) {
        errors.push(
            'The username must be alphanumeric and can only contain dots (.) or underscores (_).'
        );
    }
    return { valid: errors.length === 0, errors };
}

// --- Core Authentication Exports ---

exports.createUser = async function (discordID, username, password) {
    const usernameMatch = querySingle('SELECT DISTINCT * FROM users WHERE username=?', [username]);
    if (usernameMatch) {
        return { status: 'error', reason: 'An account with that username exists!' };
    }
    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
        return { status: 'error', reason: usernameValidation.errors.join('\n') };
    }
    const discordMatch = querySingle('SELECT DISTINCT * FROM users WHERE discordID=?', [discordID]);
    if (discordMatch) {
        return {
            status: 'error',
            reason: "There's already an account linked to that Discord account!\nTry resetting your password on the login page.",
        };
    }
    const tested = validatePassword(password);
    if (tested.strong) {
        const hashedPassword = await bcrypt.hash(password, saltRounds);
        queryRun('INSERT INTO users (discordID, username, hashedPassword) VALUES (?,?,?)', [
            discordID,
            username,
            hashedPassword,
        ]);
        return { status: 'success' };
    } else {
        return { status: 'error', reason: tested.errors.join('\n') };
    }
};

exports.login = async function (username, password, totpToken) {
    const rateKey = `login:${(username || '').toLowerCase()}`;
    if (isRateLimited(rateKey, LOGIN_MAX_FAILS)) {
        return {
            status: 'error',
            reason: 'Too many failed login attempts. Please wait a few minutes and try again.',
        };
    }
    const match = querySingle('SELECT DISTINCT * FROM users WHERE username=?', [username]);
    // Use one generic message for both "no such user" and "wrong password" so
    // the response can't be used to enumerate which usernames exist. Still run
    // a bcrypt compare against a dummy hash on the missing-user path to keep the
    // timing roughly constant.
    if (!match) {
        await bcrypt.compare(password || '', DUMMY_PASSWORD_HASH);
        registerFailure(rateKey, LOGIN_WINDOW_MS);
        return { status: 'error', reason: 'Incorrect username or password!' };
    }

    const correctPassword = await bcrypt.compare(password, match.hashedPassword);
    if (!correctPassword) {
        registerFailure(rateKey, LOGIN_WINDOW_MS);
        return { status: 'error', reason: 'Incorrect username or password!' };
    }

    // Check 2FA if enabled
    if (match.totp_secret) {
        const code = (totpToken || '').trim();
        if (!code) {
            registerFailure(rateKey, LOGIN_WINDOW_MS);
            return { status: 'error', reason: 'Invalid 2FA code!' };
        }
        // Try TOTP first (only if it looks like a 6-digit code), then fall back to backup code
        const totpValid = /^\d{6}$/.test(code)
            ? otplib.verifySync({ type: 'totp', token: code, secret: match.totp_secret }).valid
            : false;
        const codeAccepted = totpValid || (await verifyBackupCode(match.discordID, code));
        if (!codeAccepted) {
            registerFailure(rateKey, LOGIN_WINDOW_MS);
            return { status: 'error', reason: 'Invalid 2FA code!' };
        }
    }

    clearFailures(rateKey);
    const sessionID = uuidv4();
    const expiresAt = unixTime() + expiryTime;
    queryRun('INSERT INTO sessions VALUES (?,?,?)', [match.discordID, sessionID, expiresAt]);
    return { status: 'success', sessionID: sessionID, expires: expiresAt };
};

exports.createSession = function (discordID) {
    const sessionID = uuidv4();
    const expiresAt = unixTime() + expiryTime;
    queryRun('INSERT INTO sessions VALUES (?,?,?)', [discordID, sessionID, expiresAt]);
    return sessionID;
};

exports.getCookieHeader = function (sessionID) {
    const cookieExpiry = new Date(Date.now() + expiryTime * 1000).toUTCString();
    return `sessionID=${sessionID}; Path=/; expires=${cookieExpiry}; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}`;
};

exports.checkSession = async function (sessionID) {
    const time = unixTime();
    // Throttle cleanup: only delete expired sessions once per minute
    if (time - _lastSessionCleanup >= 60) {
        _lastSessionCleanup = time;
        _stmtDeleteExpiredSessions.run(time);
    }
    const match = _stmtGetSessionWithUser.get(sessionID, time);
    return match ? match.discordID : false;
};

exports.logout = function (discordID) {
    queryRun('DELETE FROM sessions WHERE discordID=?', [discordID]);
};

exports.getUsername = async function (discordID) {
    const match = querySingle('SELECT DISTINCT username FROM users WHERE discordID=?', [discordID]);
    return match ? match.username : false;
};

// --- Verification & Action Codes ---

exports.createVerificationCode = async function (discordID) {
    const time = unixTime();
    queryRun('DELETE FROM verificationcodes WHERE NOT expires > ?', [time]);
    const match = querySingle(
        'SELECT DISTINCT code FROM verificationcodes WHERE discordID=? AND expires > ?',
        [discordID, time]
    );
    if (match) {
        return match.code;
    }
    const generatedCode = uuidv4().slice(0, 8) + 'a' + uuidv4().slice(9, 10);
    queryRun('INSERT INTO verificationcodes VALUES (?,?,?)', [
        discordID,
        generatedCode,
        time + codeExpiryTime,
    ]);
    return generatedCode;
};

exports.checkVerificationCode = async function (code) {
    const time = unixTime();
    queryRun('DELETE FROM verificationcodes WHERE NOT expires > ?', [time]);
    const match = querySingle(
        'SELECT DISTINCT discordID FROM verificationcodes WHERE code=? AND expires > ?',
        [code, time]
    );
    return match ? match.discordID : false;
};

exports.createActionCode = function (discordID, action) {
    const time = unixTime();
    queryRun('DELETE FROM action_codes WHERE NOT expires > ?', [time]);
    const existing = querySingle(
        'SELECT code FROM action_codes WHERE discordID=? AND action=? AND expires > ?',
        [discordID, action, time]
    );
    if (existing) {
        return existing.code;
    }
    const code = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
    queryRun(
        'INSERT OR REPLACE INTO action_codes (discordID, action, code, expires) VALUES (?,?,?,?)',
        [discordID, action, code, time + actionCodeExpiryTime]
    );
    return code;
};

exports.verifyAndConsumeActionCode = function (discordID, action, code) {
    const rateKey = `action:${discordID}:${action}`;
    if (isRateLimited(rateKey, CODE_MAX_FAILS)) {
        return false;
    }
    const time = unixTime();
    const match = querySingle(
        'SELECT code FROM action_codes WHERE discordID=? AND action=? AND expires > ?',
        [discordID, action, time]
    );
    if (!match || match.code !== (code || '').trim()) {
        registerFailure(rateKey, CODE_WINDOW_MS);
        return false;
    }
    clearFailures(rateKey);
    queryRun('DELETE FROM action_codes WHERE discordID=? AND action=?', [discordID, action]);
    return true;
};

// --- 2FA / TOTP Management ---

function generateBackupCodeValue() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // unambiguous charset
    return Array.from({ length: 10 }, () => chars[crypto.randomInt(chars.length)]).join('');
}

async function verifyBackupCode(discordID, plainCode) {
    const rows = queryAll('SELECT id, code_hash FROM backup_codes WHERE discordID=?', [discordID]);
    for (const row of rows) {
        const match = await bcrypt.compare(plainCode.toUpperCase(), row.code_hash);
        if (match) {
            queryRun('DELETE FROM backup_codes WHERE id=?', [row.id]);
            return true;
        }
    }
    return false;
}

exports.beginTOTPSetup = async function (discordID, username) {
    const time = unixTime();
    queryRun('DELETE FROM pending_totp WHERE NOT expires > ?', [time]);
    const existing = querySingle(
        'SELECT secret FROM pending_totp WHERE discordID=? AND expires > ?',
        [discordID, time]
    );
    const secret = existing ? existing.secret : otplib.generateSecret();
    const otpauthUrl = otplib.generateURI({
        type: 'totp',
        secret,
        label: username || discordID,
        issuer: 'Discross',
    });
    const qrDataUrl = await qrcode.toDataURL(otpauthUrl);
    if (!existing) {
        queryRun(
            'INSERT OR REPLACE INTO pending_totp (discordID, secret, expires) VALUES (?,?,?)',
            [discordID, secret, time + pendingTotpExpiryTime]
        );
    }
    return { secret, qrDataUrl };
};

exports.verifyAndEnableTOTP = async function (discordID, password, token) {
    const user = querySingle('SELECT hashedPassword, totp_secret FROM users WHERE discordID=?', [
        discordID,
    ]);
    if (!user) return { success: false, error: 'User not found.' };
    if (user.totp_secret)
        return {
            success: false,
            error: '2FA is already enabled. Disable it first before setting it up again.',
        };

    const correctPassword = await bcrypt.compare(password || '', user.hashedPassword);
    if (!correctPassword) return { success: false, error: 'Incorrect password.' };

    const time = unixTime();
    const pending = querySingle(
        'SELECT secret FROM pending_totp WHERE discordID=? AND expires > ?',
        [discordID, time]
    );
    if (!pending) return { success: false, error: 'Setup session expired. Please start again.' };

    let result = { valid: false };
    try {
        result = otplib.verifySync({
            type: 'totp',
            token: (token || '').trim(),
            secret: pending.secret,
        });
    } catch (e) {}

    if (!result.valid) return { success: false, error: 'Invalid code. Please try again.' };

    queryRun('UPDATE users SET totp_secret=? WHERE discordID=?', [pending.secret, discordID]);
    queryRun('DELETE FROM pending_totp WHERE discordID=?', [discordID]);
    queryRun('DELETE FROM backup_codes WHERE discordID=?', [discordID]);

    const backupCodes = [];
    for (let i = 0; i < 8; i++) {
        const code = generateBackupCodeValue();
        backupCodes.push(code);
        const hash = await bcrypt.hash(code, saltRounds);
        queryRun('INSERT INTO backup_codes (discordID, code_hash) VALUES (?,?)', [discordID, hash]);
    }
    return { success: true, backupCodes };
};

exports.disableTOTP = async function (discordID, password) {
    const user = querySingle('SELECT hashedPassword, totp_secret FROM users WHERE discordID=?', [
        discordID,
    ]);
    if (!user) return { success: false, error: 'User not found.' };
    if (!user.totp_secret) return { success: false, error: '2FA is not enabled on this account.' };

    const correctPassword = await bcrypt.compare(password || '', user.hashedPassword);
    if (!correctPassword) return { success: false, error: 'Incorrect password.' };

    queryRun('UPDATE users SET totp_secret=NULL WHERE discordID=?', [discordID]);
    queryRun('DELETE FROM backup_codes WHERE discordID=?', [discordID]);
    queryRun('DELETE FROM pending_totp WHERE discordID=?', [discordID]);
    return { success: true };
};

exports.getTOTPStatus = function (discordID) {
    const match = querySingle('SELECT totp_secret FROM users WHERE discordID=?', [discordID]);
    return !!(match && match.totp_secret);
};

exports.changePassword = async function (discordID, currentPassword, newPassword) {
    const match = querySingle('SELECT hashedPassword FROM users WHERE discordID=?', [discordID]);
    if (!match) return { status: 'error', reason: 'User not found.' };

    const correctPassword = await bcrypt.compare(currentPassword, match.hashedPassword);
    if (!correctPassword) return { status: 'error', reason: 'Current password is incorrect.' };

    const tested = validatePassword(newPassword);
    if (!tested.strong) return { status: 'error', reason: tested.errors.join('\n') };

    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);
    queryRun('UPDATE users SET hashedPassword=? WHERE discordID=?', [hashedPassword, discordID]);
    queryRun('DELETE FROM sessions WHERE discordID=?', [discordID]);
    return { status: 'success' };
};

// --- Middleware & Integration Helpers ---

exports.checkAuth = async function (req, res, noRedirect) {
    const cookies = req.headers.cookie || '';
    const cookiedict = {};

    cookies.split(';').forEach(function (cookie) {
        const parts = cookie.split('=');
        if (parts.length < 1) return;
        const key = parts.shift().trim();
        const val = parts.join('=');
        try {
            cookiedict[key] = decodeURI(val);
        } catch (e) {
            cookiedict[key] = val;
        }
    });

    const parsedUrl = new URL(req.url, 'http://localhost');
    const sessionIDToCheck = cookiedict.sessionID || parsedUrl.searchParams.get('sessionID');

    if (sessionIDToCheck) {
        const session = await exports.checkSession(sessionIDToCheck);
        if (session) return session;
    }

    if (!noRedirect) {
        res.writeHead(sessionIDToCheck ? 301 : 303, {
            Location: `/login.html?redirect=${encodeURIComponent(req.url)}`,
        });
        res.end();
    }
    return false;
};

exports.handleLoginRegister = async function (req, res, body) {
    const params = Object.fromEntries(new URLSearchParams(body));
    // Re-parse username without + → space conversion: old browsers (DSi Opera 9.5) send
    // + literally without encoding it as %2B, and some accounts predate username validation.
    const rawUsernameMatch = body.match(/(?:^|&)username=([^&]*)/);
    if (rawUsernameMatch) {
        try {
            params.username = decodeURIComponent(rawUsernameMatch[1]);
        } catch {}
    }

    if (req.url === '/login') {
        if (params.username && params.password) {
            const result = await exports.login(params.username, params.password, params.totp_code);
            if (result.status === 'success') {
                const cookieExpiry = new Date(Date.now() + expiryTime * 1000).toUTCString();
                const redirectBase = (() => {
                    try {
                        const redirectUrl = new URL(
                            params.redirect || '/server/',
                            'http://localhost'
                        );
                        redirectUrl.searchParams.delete('sessionID');
                        return (
                            redirectUrl.pathname +
                            (redirectUrl.search || '') +
                            (redirectUrl.hash || '')
                        );
                    } catch {
                        return params.redirect || '/server/';
                    }
                })();
                const sep = redirectBase.includes('?') ? '&' : '?';
                const redirectPath = `${redirectBase}${sep}sessionID=${encodeURIComponent(result.sessionID)}#end`;
                res.writeHead(200, {
                    'Set-Cookie': [
                        `sessionID=${result.sessionID}; path=/; expires=${cookieExpiry}; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}`,
                    ],
                    Location: redirectPath,
                    'Content-Type': 'text/html',
                });
                res.end(
                    renderTemplate(getTemplate('redirect-page', 'misc'), {
                        REDIRECT_URL: he.encode(redirectPath),
                    })
                );
            } else {
                req.url = `/login.html?errortext=${encodeURIComponent(result.reason)}`;
                await require('../pages/login').processLogin(null, req, res, []);
            }
        } else {
            req.url = `/login.html?errortext=${encodeURIComponent('Please enter both a username and password.')}`;
            await require('../pages/login').processLogin(null, req, res, []);
        }
    } else if (req.url === '/register') {
        if (params.username && params.password && params.confirm && params.token) {
            if (params.confirm !== params.password) {
                req.url = `/register.html?errortext=${encodeURIComponent("Password confirmation doesn't match password!")}`;
                await require('../pages/register').processRegister(null, req, res, []);
                return;
            }
            const id = await exports.checkVerificationCode(params.token);
            if (!id) {
                req.url = `/register.html?errortext=${encodeURIComponent('Invalid verification code!\nType ^connect on a server with the Discross bot.')}`;
                await require('../pages/register').processRegister(null, req, res, []);
                return;
            }
            const result = await exports.createUser(id, params.username, params.password);
            if (result.status === 'success') {
                res.writeHead(301, { Location: '/login.html' });
                res.end();
            } else {
                req.url = `/register.html?errortext=${encodeURIComponent(result.reason)}`;
                await require('../pages/register').processRegister(null, req, res, []);
            }
        } else {
            req.url = `/register.html?errortext=${encodeURIComponent('Please fill in all boxes!')}`;
            await require('../pages/register').processRegister(null, req, res, []);
        }
    } else if (req.url === '/forgot') {
        if (params.token) {
            const id = await exports.checkVerificationCode(params.token);
            if (!id) {
                req.url = `/forgot.html?errortext=${encodeURIComponent('Invalid verification code!\nType ^connect on a server with the Discross bot.')}`;
                await require('../pages/forgot').processForgot(null, req, res, []);
                return;
            }
            queryRun('DELETE FROM users WHERE discordID = ?', [id]);
            queryRun('DELETE FROM sessions WHERE discordID = ?', [id]);
            queryRun('DELETE FROM verificationcodes WHERE discordID = ?', [id]);
            queryRun('DELETE FROM servers WHERE discordID = ?', [id]);
            queryRun('DELETE FROM backup_codes WHERE discordID = ?', [id]);
            queryRun('DELETE FROM pending_totp WHERE discordID = ?', [id]);
            res.writeHead(303, { Location: '/register.html' });
            res.end();
        } else {
            req.url = `/forgot.html?errortext=${encodeURIComponent('Please fill the code!')}`;
            await require('../pages/forgot').processForgot(null, req, res, []);
        }
    }
};

// --- Preference & Server Management ---

exports.insertServers = function (items) {
    const serversQuery = db.prepare('INSERT OR IGNORE INTO servers VALUES (@serverID, @discordID)');
    const transaction = db.transaction(function (items) {
        for (const item of items) serversQuery.run(item);
    });
    return transaction(items);
};

exports.getChannelPreferences = function (discordID, serverID) {
    return queryAll(
        'SELECT channelID, collapsed FROM channel_preferences WHERE discordID=? AND serverID=?',
        [discordID, serverID]
    );
};

exports.setChannelPreference = function (discordID, serverID, categoryID, collapsed) {
    try {
        queryRun(
            'INSERT OR REPLACE INTO channel_preferences (discordID, serverID, channelID, collapsed) VALUES (?, ?, ?, ?)',
            [discordID, serverID, categoryID, collapsed]
        );
        return { success: true };
    } catch (err) {
        console.error('Error setting channel preference:', err);
        return { success: false, error: err.message };
    }
};

exports.isGuestChannel = function (channelID) {
    return !!querySingle('SELECT 1 FROM guest_channels WHERE channelID=?', [channelID]);
};

exports.toggleGuestChannel = function (channelID) {
    if (exports.isGuestChannel(channelID)) {
        queryRun('DELETE FROM guest_channels WHERE channelID=?', [channelID]);
        return false;
    } else {
        queryRun('INSERT INTO guest_channels VALUES (?)', [channelID]);
        return true;
    }
};

exports.saveDiscordTokens = function (discordID, accessToken, refreshToken, expiresAt) {
    return queryRun(
        'UPDATE users SET discord_access_token=?, discord_refresh_token=?, discord_token_expires=? WHERE discordID=?',
        [accessToken, refreshToken, expiresAt, discordID]
    );
};

exports.getDiscordTokens = function (discordID) {
    return querySingle(
        'SELECT discord_access_token, discord_refresh_token, discord_token_expires FROM users WHERE discordID=?',
        [discordID]
    );
};

exports.getPasskeyOptions = function (discordID, type = 'register', rpId = 'localhost') {
    const challenge = crypto.randomBytes(32);
    // Remember the challenge so verifyPasskey() can confirm the authenticator
    // signed exactly this value (single-use, tied to this RP ID and account).
    const challengeB64url = challenge.toString('base64url');
    storePasskeyChallenge(challengeB64url, { type, discordID, rpId, challengeB64url });
    const options = {
        challenge: Array.from(challenge),
        timeout: 60000,
        userVerification: type === 'login' ? 'required' : 'preferred',
    };
    // The two ceremonies name the relying party differently:
    // navigator.credentials.create() takes an `rp` object, while .get() takes a
    // plain `rpId` string. Sending `rp` to .get() is not a member of
    // PublicKeyCredentialRequestOptions, so the browser ignores it and falls
    // back to the origin's effective domain — which silently breaks the login
    // whenever that differs from the RP ID the passkey was registered under.
    if (type === 'register') {
        options.rp = { id: rpId, name: 'Discross' };
    } else {
        options.rpId = rpId;
    }
    if (type === 'register') {
        const user = querySingle('SELECT username FROM users WHERE discordID = ?', [discordID]);
        const username = user ? user.username : discordID;
        options.user = {
            id: Array.from(Buffer.from(discordID)),
            name: username,
            displayName: username,
        };
        options.pubKeyCredParams = [
            { alg: -7, type: 'public-key' },
            { alg: -257, type: 'public-key' },
        ];
        options.authenticatorSelection = {
            residentKey: 'required',
            requireResidentKey: true,
            userVerification: 'preferred',
        };
    } else {
        const credentials = queryAll('SELECT credentialID FROM passkeys WHERE discordID = ?', [
            discordID,
        ]);
        if (credentials.length > 0) {
            options.allowCredentials = credentials.map((row) => ({
                id: Array.from(Buffer.from(row.credentialID, 'base64url')),
                type: 'public-key',
            }));
        }
    }
    return options;
};

exports.verifyPasskey = async function (discordID, type, response) {
    if (!response.id || !response.rawId) return { success: false, error: 'Invalid response' };

    if (type === 'register') {
        if (!response.clientDataJSON || !response.attestationObject) {
            return { success: false, error: 'Missing attestation data' };
        }
        // Recover the challenge from the client data so we can look up what we
        // issued (and which RP ID it was bound to), then consume it.
        let clientData;
        try {
            clientData = JSON.parse(
                Buffer.from(response.clientDataJSON, 'base64').toString('utf8')
            );
        } catch {
            return { success: false, error: 'Invalid client data' };
        }
        const challenge = consumePasskeyChallenge((clientData.challenge || '').replace(/=+$/, ''));
        if (!challenge || challenge.type !== 'register' || challenge.discordID !== discordID) {
            return { success: false, error: 'Challenge expired or invalid. Please try again.' };
        }

        let result;
        try {
            result = webauthn.verifyRegistration(response, {
                expectedChallenge: challenge.challengeB64url,
                expectedRpId: challenge.rpId,
            });
        } catch (err) {
            console.error('Passkey registration verification failed:', err.message);
            return { success: false, error: 'Passkey verification failed.' };
        }

        queryRun(
            'INSERT OR REPLACE INTO passkeys (discordID, credentialID, publicKey, counter) VALUES (?,?,?,?)',
            [discordID, result.credentialId, result.publicKeyDer, result.signCount]
        );
        return { success: true };
    } else {
        // The login client nests the assertion under `response.response`.
        const assertion = response.response || {};
        if (!assertion.clientDataJSON || !assertion.authenticatorData || !assertion.signature) {
            return { success: false, error: 'Missing assertion data' };
        }
        let clientData;
        try {
            clientData = JSON.parse(
                Buffer.from(assertion.clientDataJSON, 'base64').toString('utf8')
            );
        } catch {
            return { success: false, error: 'Invalid client data' };
        }
        const challenge = consumePasskeyChallenge((clientData.challenge || '').replace(/=+$/, ''));
        if (!challenge || challenge.type !== 'login') {
            return { success: false, error: 'Challenge expired or invalid. Please try again.' };
        }

        // The credential id (response.id) is base64url; the DB stores it the same way.
        const passkey = querySingle(
            'SELECT discordID, publicKey, counter FROM passkeys WHERE credentialID = ?' +
                (discordID ? ' AND discordID = ?' : ''),
            discordID ? [response.id, discordID] : [response.id]
        );
        if (!passkey) return { success: false, error: 'Passkey not found' };

        let result;
        try {
            result = webauthn.verifyAssertion(assertion, {
                publicKeyDer: passkey.publicKey,
                expectedChallenge: challenge.challengeB64url,
                expectedRpId: challenge.rpId,
                storedSignCount: passkey.counter || 0,
            });
        } catch (err) {
            console.error('Passkey assertion verification failed:', err.message);
            return { success: false, error: 'Passkey verification failed.' };
        }

        queryRun('UPDATE passkeys SET counter=? WHERE credentialID=?', [
            result.newSignCount,
            response.id,
        ]);
        return { success: true, discordID: passkey.discordID };
    }
};

// --- Mail System Management ---

exports.getMailUser = function (discordID) {
    return querySingle('SELECT * FROM mail_users WHERE discordID=?', [discordID]);
};

exports.getMailUserByEmail = function (email_prefix) {
    return querySingle('SELECT * FROM mail_users WHERE email_prefix=?', [email_prefix]);
};

exports.setMailUser = function (discordID, email_prefix, active = 1) {
    try {
        queryRun(
            'INSERT OR REPLACE INTO mail_users (discordID, email_prefix, active) VALUES (?, ?, ?)',
            [discordID, email_prefix, active]
        );
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
};

exports.toggleMailOptOut = function (discordID) {
    const user = exports.getMailUser(discordID);
    if (!user) return { success: false, error: 'User is not registered for email.' };
    const newActive = user.active ? 0 : 1;
    queryRun('UPDATE mail_users SET active=? WHERE discordID=?', [newActive, discordID]);
    return { success: true, active: newActive };
};

exports.addMailBlock = function (discordID, blocked_email) {
    try {
        queryRun('INSERT OR IGNORE INTO mail_blocks (discordID, blocked_email) VALUES (?, ?)', [
            discordID,
            blocked_email.toLowerCase(),
        ]);
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
};

exports.isMailBlocked = function (discordID, checkEmail) {
    const match = querySingle('SELECT 1 FROM mail_blocks WHERE discordID=? AND blocked_email=?', [
        discordID,
        checkEmail.toLowerCase(),
    ]);
    return !!match;
};

exports.createMailVerificationCode = function (discordID, email_prefix, backup_email) {
    const time = unixTime();
    queryRun('DELETE FROM mail_verifications WHERE NOT expires > ?', [time]);

    const existing = querySingle(
        'SELECT code FROM mail_verifications WHERE discordID=? AND expires > ?',
        [discordID, time]
    );
    if (existing) {
        return existing.code;
    }

    // 6 digit code for email verification
    const code = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
    // Code expires in 10 minutes
    queryRun(
        'INSERT OR REPLACE INTO mail_verifications (discordID, code, email_prefix, backup_email, expires) VALUES (?,?,?,?,?)',
        [discordID, code, email_prefix, backup_email, time + 10 * 60]
    );
    return code;
};

exports.verifyMailCode = function (discordID, code) {
    const rateKey = `mailcode:${discordID}`;
    if (isRateLimited(rateKey, CODE_MAX_FAILS)) {
        return {
            success: false,
            error: 'Too many incorrect attempts. Please wait a few minutes and try again.',
        };
    }
    const time = unixTime();
    const match = querySingle(
        'SELECT * FROM mail_verifications WHERE discordID=? AND expires > ?',
        [discordID, time]
    );

    if (!match || match.code !== (code || '').trim()) {
        registerFailure(rateKey, CODE_WINDOW_MS);
        return { success: false, error: 'Invalid or expired verification code.' };
    }

    clearFailures(rateKey);
    queryRun('DELETE FROM mail_verifications WHERE discordID=?', [discordID]);
    return { success: true, email_prefix: match.email_prefix };
};

exports.querySingle = querySingle;
exports.queryAll = queryAll;
exports.queryRun = queryRun;
