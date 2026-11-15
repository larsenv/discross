'use strict';
/**
 * Discord lookups that remember what Discord said "no" to.
 *
 * discord.js caches whatever a fetch returns, so a member, channel or thread
 * member that exists costs one request and is answered from memory afterwards.
 * One that doesn't exist is never cached, so every page load asks again and
 * waits for the same 404: the author who left the server, the mention of a
 * deleted channel, the thread the viewer isn't in. These helpers keep those
 * answers for a short while, and let concurrent page loads share one request.
 */

const MISS_TTL_MS = 5 * 60 * 1000;
// Thread membership and the thread list change while people are chatting, so
// they are kept for a shorter time than "this user left the server".
const THREAD_TTL_MS = 60 * 1000;
const MISS_MAX = 5000;

/**
 * Whether Discord answered that the thing doesn't exist or isn't visible to the
 * bot. Anything else (a timeout, a rate limit, a 5xx) is not remembered, so the
 * next page load tries again.
 */
function isDefinitiveMiss(err) {
    return !!err && (err.status === 404 || err.status === 403);
}

function createMissCache(ttlMs) {
    const misses = new Map(); // key -> time the miss stops being trusted
    return {
        has(key) {
            const until = misses.get(key);
            if (until === undefined) return false;
            if (until > Date.now()) return true;
            misses.delete(key);
            return false;
        },
        add(key) {
            misses.delete(key);
            if (misses.size >= MISS_MAX) misses.delete(misses.keys().next().value);
            misses.set(key, Date.now() + ttlMs);
        },
        delete(key) {
            misses.delete(key);
        },
    };
}

const memberMisses = createMissCache(MISS_TTL_MS);
const channelMisses = createMissCache(MISS_TTL_MS);
const threadMemberMisses = createMissCache(THREAD_TTL_MS);
const activeThreads = new Map(); // guildId -> { threads, at }

// Requests already on their way to Discord, so a second caller waits for the
// same answer instead of sending the request again.
const inFlight = new Map();

function shared(key, start) {
    let pending = inFlight.get(key);
    if (!pending) {
        pending = start().finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
    }
    return pending;
}

/**
 * The guild member for a user, or null when they aren't in the guild (or the
 * lookup failed).
 *
 * @param {import('discord.js').Guild} guild
 * @param {string} userId
 * @returns {Promise<import('discord.js').GuildMember|null>}
 */
function fetchMember(guild, userId) {
    const cached = guild.members.cache.get(userId);
    if (cached) return Promise.resolve(cached);
    const key = `${guild.id}:${userId}`;
    if (memberMisses.has(key)) return Promise.resolve(null);
    return shared(`member:${key}`, async () => {
        try {
            return await guild.members.fetch(userId);
        } catch (err) {
            if (isDefinitiveMiss(err)) memberMisses.add(key);
            return null;
        }
    });
}

/**
 * A channel by ID, or null when it doesn't exist or the bot can't see it.
 *
 * @param {import('discord.js').Client} client
 * @param {string} channelId
 * @returns {Promise<import('discord.js').Channel|null>}
 */
function fetchChannel(client, channelId) {
    const cached = client.channels.cache.get(channelId);
    if (cached) return Promise.resolve(cached);
    if (channelMisses.has(channelId)) return Promise.resolve(null);
    return shared(`channel:${channelId}`, async () => {
        try {
            return await client.channels.fetch(channelId);
        } catch (err) {
            if (isDefinitiveMiss(err)) channelMisses.add(channelId);
            return null;
        }
    });
}

/**
 * Whether a user has joined a thread.
 *
 * @param {import('discord.js').AnyThreadChannel} thread
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
function isThreadMember(thread, userId) {
    if (thread.members.cache.has(userId)) return Promise.resolve(true);
    const key = `${thread.id}:${userId}`;
    if (threadMemberMisses.has(key)) return Promise.resolve(false);
    return shared(`threadMember:${key}`, async () => {
        try {
            await thread.members.fetch(userId);
            return true;
        } catch (err) {
            if (isDefinitiveMiss(err)) threadMemberMisses.add(key);
            return false;
        }
    });
}

/**
 * The guild's active threads. Throws when Discord can't be reached, like
 * guild.channels.fetchActiveThreads().
 *
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<import('discord.js').AnyThreadChannel[]>}
 */
function fetchActiveThreads(guild) {
    const hit = activeThreads.get(guild.id);
    if (hit && Date.now() - hit.at < THREAD_TTL_MS) return Promise.resolve(hit.threads);
    return shared(`activeThreads:${guild.id}`, async () => {
        const result = await guild.channels.fetchActiveThreads();
        const threads = [...result.threads.values()];
        activeThreads.set(guild.id, { threads, at: Date.now() });
        return threads;
    });
}

// Called from the gateway events in src/bot.ts, so a change Discord tells us
// about shows up on the next page load instead of after the cache expires.

function forgetMissingMember(guildId, userId) {
    memberMisses.delete(`${guildId}:${userId}`);
}

function forgetMissingChannel(channelId) {
    channelMisses.delete(channelId);
}

function forgetThreadMembership(threadId, userId) {
    threadMemberMisses.delete(`${threadId}:${userId}`);
}

function forgetActiveThreads(guildId) {
    activeThreads.delete(guildId);
}

module.exports = {
    fetchMember,
    fetchChannel,
    isThreadMember,
    fetchActiveThreads,
    forgetMissingMember,
    forgetMissingChannel,
    forgetThreadMembership,
    forgetActiveThreads,
};
