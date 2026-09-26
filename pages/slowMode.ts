'use strict';

// Every outgoing message goes out through a per-channel webhook (see
// webhookCache.ts) so it can carry the sending user's name/avatar. Discord
// never applies a channel's slow mode to webhook-sent messages, so Discross
// has to enforce it itself before handing content off to the webhook.
//
// State is kept in memory only, per (channel, sender) pair, and is bounded by
// periodic cleanup — nothing here is persisted to disk.

const { PermissionFlagsBits } = require('discord');

const lastSentAt = new Map(); // `${channelId}:${senderKey}` -> timestamp (ms)

// Discord's slow mode tops out at 6 hours; anything older than that is stale
// no matter what triggered it.
const MAX_SLOWMODE_MS = 6 * 60 * 60 * 1000;

function cleanup() {
    const cutoff = Date.now() - MAX_SLOWMODE_MS;
    for (const [key, ts] of lastSentAt) {
        if (ts < cutoff) lastSentAt.delete(key);
    }
}
setInterval(cleanup, 10 * 60 * 1000).unref();

function effectiveRateLimitSeconds(channel) {
    if (!channel) return 0;
    if (typeof channel.rateLimitPerUser === 'number' && channel.rateLimitPerUser > 0) {
        return channel.rateLimitPerUser;
    }
    // A thread with no slow mode of its own inherits its parent channel's.
    if (channel.parent && typeof channel.parent.rateLimitPerUser === 'number') {
        return channel.parent.rateLimitPerUser;
    }
    return 0;
}

// Discord itself exempts members with Manage Messages or Manage Channels from
// slow mode; mirror that so moderators aren't unexpectedly throttled.
function isExempt(member, channel) {
    if (!member) return false;
    try {
        return member
            .permissionsIn(channel)
            .any([PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels], true);
    } catch {
        return false;
    }
}

/**
 * Checks whether `senderKey` may send in `channel` right now under its slow
 * mode setting. `senderKey` is the Discord user ID for authenticated sends,
 * or a synthetic per-guest identifier for guest sends.
 *
 * @returns {{allowed: true} | {allowed: false, retryAfterSeconds: number}}
 */
exports.checkSlowMode = function checkSlowMode(channel, senderKey, member) {
    const seconds = effectiveRateLimitSeconds(channel);
    if (!seconds || isExempt(member, channel)) {
        return { allowed: true };
    }

    const key = `${channel.id}:${senderKey}`;
    const last = lastSentAt.get(key);
    if (last == null) return { allowed: true };

    const waitMs = seconds * 1000 - (Date.now() - last);
    if (waitMs <= 0) return { allowed: true };

    return { allowed: false, retryAfterSeconds: Math.ceil(waitMs / 1000) };
};

/**
 * Records that `senderKey` just sent a message in `channel`, starting its
 * slow mode cooldown. Call this only after a successful send.
 */
exports.recordSend = function recordSend(channel, senderKey) {
    lastSentAt.set(`${channel.id}:${senderKey}`, Date.now());
};
