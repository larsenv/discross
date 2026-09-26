'use strict';

// Discord's own clients gate NSFW channels behind an account-level age check:
// once a user has verified their age with Discord, the `/users/@me` payload
// (available with the `identify` OAuth scope, which Discross already requests
// to sync a user's server list) carries `nsfw_allowed: true`. Discross has no
// way to run Discord's own age-verification flow itself, so it defers to that
// same flag rather than asking users to self-report their age.
//
// A user who has never linked their Discord account via OAuth (only the bot
// DM `^connect` flow, which grants no token) has no flag to check and is
// therefore treated as unverified.

const auth = require('../src/authentication');

// In-memory cache of verification results. Bounded and time-limited, never
// written to disk: see the caching rules for message/user data elsewhere in
// this app.
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_CACHE_SIZE = 1000;
const verifiedCache = new Map(); // discordID -> { value, expires }

function cacheGet(discordID) {
    const entry = verifiedCache.get(discordID);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
        verifiedCache.delete(discordID);
        return undefined;
    }
    return entry.value;
}

function cacheSet(discordID, value) {
    if (verifiedCache.size >= MAX_CACHE_SIZE && !verifiedCache.has(discordID)) {
        verifiedCache.delete(verifiedCache.keys().next().value);
    }
    verifiedCache.set(discordID, { value, expires: Date.now() + CACHE_TTL_MS });
}

async function refreshAccessToken(discordID, refreshToken) {
    const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET } = require('../index');
    if (!DISCORD_CLIENT_SECRET) return null;

    try {
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: DISCORD_CLIENT_ID,
                client_secret: DISCORD_CLIENT_SECRET,
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
            }),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        const tokenData = await tokenResponse.json();
        if (!tokenData.access_token) return null;

        auth.saveDiscordTokens(
            discordID,
            tokenData.access_token,
            tokenData.refresh_token,
            Math.floor(Date.now() / 1000) + (tokenData.expires_in || 0)
        );
        return tokenData.access_token;
    } catch (err) {
        console.warn('Error refreshing Discord token for age verification:', err);
        return null;
    }
}

/**
 * Whether Discord has age-verified this user's account (the same signal
 * Discord's own clients use to gate NSFW content). Returns false whenever
 * this can't be confirmed, which is the safe default for NSFW gating.
 *
 * @param {string} discordID
 * @returns {Promise<boolean>}
 */
async function isAgeVerified(discordID) {
    if (!discordID) return false;

    const cached = cacheGet(discordID);
    if (cached !== undefined) return cached;

    const tokens = auth.getDiscordTokens(discordID);
    if (!tokens || !tokens.discord_access_token) {
        cacheSet(discordID, false);
        return false;
    }

    let accessToken = tokens.discord_access_token;
    const now = Math.floor(Date.now() / 1000);
    if (!tokens.discord_token_expires || tokens.discord_token_expires < now + 300) {
        if (!tokens.discord_refresh_token) {
            cacheSet(discordID, false);
            return false;
        }
        accessToken = await refreshAccessToken(discordID, tokens.discord_refresh_token);
        if (!accessToken) {
            cacheSet(discordID, false);
            return false;
        }
    }

    try {
        const response = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) {
            cacheSet(discordID, false);
            return false;
        }
        const user: any = await response.json();
        const verified = user?.nsfw_allowed === true;
        cacheSet(discordID, verified);
        return verified;
    } catch (err) {
        console.warn('Error checking Discord age verification status:', err);
        cacheSet(discordID, false);
        return false;
    }
}

module.exports = { isAgeVerified };
