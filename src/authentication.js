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
const { getTemplate, renderTemplate } = require('../pages/utils.js');

// --- Configuration & Constants ---

const saltRounds = 10;
const expiryTime = 7 * 24 * 60 * 60; // For sessions - expires in 1 week
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
    queryRun(
        'CREATE TABLE IF NOT EXISTS message_user_agents (messageID TEXT PRIMARY KEY, userAgent TEXT)'
    );
}

setup();

// Pre-compiled statements for the hot path
const _stmtDeleteExpiredSessions = db.prepare('DELETE FROM sessions WHERE expires <= ?');
const _stmtGetSessionWithUser = db.prepare(
    'SELECT s.discordID FROM sessions s INNER JOIN users u ON u.discordID = s.discordID WHERE s.sessionID = ? AND s.expires > ?'
);
let _lastSessionCleanup = 0;

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
    const match = querySingle('SELECT DISTINCT * FROM users WHERE username=?', [username]);
    if (!match) {
        return { status: 'error', reason: "That account doesn't exist!" };
    }

    const correctPassword = await bcrypt.compare(password, match.hashedPassword);
    if (!correctPassword) {
        return { status: 'error', reason: 'Incorrect password!' };
    }

    // Check 2FA if enabled
    if (match.totp_secret) {
        const code = (totpToken || '').trim();
        if (!code) {
            return { status: 'error', reason: 'Invalid 2FA code!' };
        }
        // Try TOTP first (only if it looks like a 6-digit code), then fall back to backup code
        const totpValid = /^\d{6}$/.test(code)
            ? otplib.verifySync({ type: 'totp', token: code, secret: match.totp_secret }).valid
            : false;
        const codeAccepted = totpValid || (await verifyBackupCode(match.discordID, code));
        if (!codeAccepted) {
            return { status: 'error', reason: 'Invalid 2FA code!' };
        }
    }

    const sessionID = uuidv4();
    const expiresAt = unixTime() + expiryTime;
    queryRun('INSERT INTO sessions VALUES (?,?,?)', [match.discordID, sessionID, expiresAt]);
    return { status: 'success', sessionID: sessionID, expires: expiresAt };
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
    const time = unixTime();
    const match = querySingle(
        'SELECT code FROM action_codes WHERE discordID=? AND action=? AND expires > ?',
        [discordID, action, time]
    );
    if (!match || match.code !== (code || '').trim()) {
        return false;
    }
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
                        `sessionID=${result.sessionID}; path=/; expires=${cookieExpiry}; HttpOnly${https ? '; Secure' : ''}`,
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
                res.writeHead(301, {
                    Location: `/login.html?errortext=${encodeURIComponent(result.reason)}`,
                });
                res.end();
            }
        }
    } else if (req.url === '/register') {
        if (params.username && params.password && params.confirm && params.token) {
            if (params.confirm !== params.password) {
                res.writeHead(301, {
                    Location:
                        "/register.html?errortext=Password+confirmation+doesn't+match+password!",
                });
                res.end();
                return;
            }
            const id = await exports.checkVerificationCode(params.token);
            if (!id) {
                res.writeHead(301, {
                    Location:
                        '/register.html?errortext=Invalid+verification+code!%0AType+%5Econnect+on+a+server+with+the+Discross+bot.',
                });
                res.end();
                return;
            }
            const result = await exports.createUser(id, params.username, params.password);
            if (result.status === 'success') {
                res.writeHead(301, { Location: '/login.html' });
                res.end();
            } else {
                res.writeHead(301, {
                    Location: `/register.html?errortext=${encodeURIComponent(result.reason)}`,
                });
                res.end();
            }
        } else {
            res.writeHead(303, { Location: '/register.html?errortext=Please+fill+in+all+boxes!' });
            res.end();
        }
    } else if (req.url === '/forgot') {
        if (params.token) {
            const id = await exports.checkVerificationCode(params.token);
            if (!id) {
                res.writeHead(301, {
                    Location:
                        '/forgot.html?errortext=Invalid+verification+code!%0AType+%5Econnect+on+a+server+with+the+Discross+bot.',
                });
                res.end();
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
            res.writeHead(303, { Location: '/forgot.html?errortext=Please+fill+the+code!' });
            res.end();
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

exports.getPasskeyOptions = function (discordID, type = 'register') {
    const challenge = crypto.randomBytes(32);
    const options = {
        challenge: Array.from(challenge),
        rpId: 'localhost', // Should be dynamic
        timeout: 60000,
        userVerification: 'preferred',
    };
    if (type === 'register') {
        options.user = { id: Array.from(Buffer.from(discordID)), name: discordID, displayName: discordID };
        options.pubKeyCredParams = [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }];
    } else {
        options.allowCredentials = queryAll('SELECT credentialID FROM passkeys WHERE discordID = ?', [discordID])
            .map(row => ({ id: Buffer.from(row.credentialID, 'base64'), type: 'public-key' }));
    }
    return options;
};

exports.verifyPasskey = async function (discordID, type, response) {
    if (!response.id || !response.rawId) return { success: false, error: 'Invalid response' };
    
    if (type === 'register') {
        queryRun('INSERT INTO passkeys (discordID, credentialID, publicKey) VALUES (?,?,?)', [
            discordID,
            response.id,
            Buffer.from(response.rawId, 'base64')
        ]);
        return { success: true };
    } else {
        const passkey = querySingle('SELECT publicKey, counter FROM passkeys WHERE credentialID = ? AND discordID = ?', [response.id, discordID]);
        if (!passkey) return { success: false, error: 'Passkey not found' };
        
        // TODO: Signature verification logic using public key would go here.
        // For now, return success if credentialID is found.
        return { success: true };
    }
};
