'use strict';
/**
 * Real-time WebSocket connection handler for Discross.
 * Manages connected clients and pushes Discord messages to browsers.
 */
const WebSocket = require('ws');
const Redis = require('ioredis');
const auth = require('./authentication');

// Initialize Redis clients for session storage and pub/sub
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const redis = new Redis(redisUrl);
const pub = new Redis(redisUrl);
const sub = new Redis(redisUrl);

// Suppress unhandled error events if Redis is not running locally
redis.on('error', () => {});
pub.on('error', () => {});
sub.on('error', () => {});

/**
 * @typedef {Object} ClientState
 * @property {boolean} isAuthed
 * @property {string} listenChannel
 * @property {string} [sessionId]
 * @property {string|false} [discordID]
 */

// Use a Map to associate WebSocket instances with their subscription state.
/** @type {Map<WebSocket, ClientState>} */
const clients = new Map();

/**
 * Sends a message to all clients listening to a specific channel.
 * Broadcasts via Redis Pub/Sub to reach all Node.js instances.
 * @param {string} message - The message payload to send
 * @param {string} channel - The Discord channel ID
 */
async function sendToAll(message, channel) {
    if (pub.status === 'ready') {
        try {
            await pub.publish(`channel:${channel}`, message);
            return;
        } catch (err) {
            if (err.name !== 'MaxRetriesPerRequestError') {
                console.error('Failed to publish message to Redis:', err);
            }
        }
    }

    // Fallback: send directly to local connected clients if Redis is offline/failing
    for (const [socket, state] of clients.entries()) {
        if (state.listenChannel === channel && socket.readyState === WebSocket.OPEN) {
            socket.send(message);
        }
    }
}

// Subscribe to all channel messages
sub.psubscribe('channel:*', (err) => {
    if (err && err.name !== 'MaxRetriesPerRequestError') {
        console.error('Failed to subscribe to Redis channels:', err);
    }
});

sub.on('pmessage', (pattern, redisChannel, message) => {
    const discordChannel = redisChannel.replace('channel:', '');
    for (const [socket, state] of clients.entries()) {
        if (state.listenChannel === discordChannel && socket.readyState === WebSocket.OPEN) {
            socket.send(message);
        }
    }
});

exports.sendToAll = sendToAll;

/**
 * Determines whether the authenticated user (or a guest, for guest-enabled
 * channels) is allowed to receive the live message feed for a channel.
 *
 * This mirrors the permission checks the HTTP channel view performs, so the
 * real-time socket can't be used to read messages from channels the caller
 * has no access to. Without this, any client could `LISTEN` on an arbitrary
 * channel snowflake and passively receive every message posted there.
 *
 * @param {string|false} discordID - Authenticated Discord user ID, or false for a guest.
 * @param {string} channelID - The Discord channel snowflake to listen on.
 * @returns {Promise<boolean>}
 */
async function canListenToChannel(discordID, channelID) {
    if (!channelID) return false;

    // Guest-enabled channels are viewable without an account (parity with the
    // HTTP guest channel view).
    if (!discordID) {
        return auth.isGuestChannel(channelID);
    }

    // Lazy require to avoid a load-time circular dependency (bot.js requires
    // this module). Node resolves the cached module fine at call time.
    const bot = require('./bot');
    const { canViewChannel } = require('../pages/utils');
    if (!bot.client) return false;

    const channel =
        bot.client.channels.cache.get(channelID) ||
        (await bot.client.channels.fetch(channelID).catch(() => null));
    if (!channel || !channel.guild) return false;

    const member = await channel.guild.members.fetch(discordID).catch(() => null);
    if (!member) return false;
    const botMember = channel.guild.members.me;

    return canViewChannel(member, botMember, channel);
}

/**
 * Processes an incoming WebSocket message from a client.
 * @param {WebSocket} ws - The WebSocket client
 * @param {ClientState} state - The current state of the client
 * @param {WebSocket.Data} message - The incoming message
 * @returns {Promise<ClientState>} The updated state
 */
async function processMessage(ws, state, message) {
    try {
        const msgStr = message.toString();
        const parts = msgStr.split(' ');
        const action = parts[0];
        const params = parts.slice(1).join(' ');

        if (action === 'AUTH') {
            // The token is a Discross session ID. Validate it against the session
            // store instead of trusting any string the client sends; only an
            // authenticated socket may subscribe to non-guest channels.
            const token = params.trim();
            const discordID = token ? await auth.checkSession(token) : false;
            if (discordID) {
                state.isAuthed = true;
                state.discordID = discordID;
                state.sessionId = `session:${token}`;
                if (redis.status === 'ready') {
                    await redis.set(
                        state.sessionId,
                        JSON.stringify({
                            isAuthed: true,
                            listenChannel: state.listenChannel,
                            discordID,
                        }),
                        'EX',
                        86400
                    ); // Expire in 24 hours
                }
            } else {
                state.isAuthed = false;
                state.discordID = false;
                ws.send(JSON.stringify({ error: 'Authentication failed' }));
            }
        } else if (action === 'LISTEN') {
            const channelID = params.trim();
            // Authorize before subscribing: the caller must be able to view this
            // channel (or it must be a guest-enabled channel).
            if (await canListenToChannel(state.discordID || false, channelID)) {
                state.listenChannel = channelID;
                if (state.sessionId && redis.status === 'ready') {
                    await redis.set(state.sessionId, JSON.stringify(state), 'EX', 86400);
                }
            } else {
                state.listenChannel = '';
                ws.send(JSON.stringify({ error: 'Not authorized for that channel' }));
            }
        } else if (action === 'RECONNECT') {
            const token = params.trim();
            // Re-validate the session on reconnect, then re-authorize the stored
            // channel — a cached Redis entry must never grant access on its own.
            const discordID = token ? await auth.checkSession(token) : false;
            if (discordID && redis.status === 'ready') {
                const sessionData = await redis.get(`session:${token}`);
                if (sessionData) {
                    const parsed = JSON.parse(sessionData);
                    state.isAuthed = true;
                    state.discordID = discordID;
                    state.sessionId = `session:${token}`;
                    state.listenChannel = (await canListenToChannel(
                        discordID,
                        parsed.listenChannel
                    ))
                        ? parsed.listenChannel
                        : '';
                }
            }
        }
    } catch (err) {
        console.error('Error processing WebSocket message:', err);
        ws.send(JSON.stringify({ error: 'Failed to process message' }));
    }
    return state;
}

exports.startWsServer = function (server) {
    const wss = new WebSocket.Server({ server });
    wss.on('connection', function connection(ws) {
        /** @type {ClientState} */
        const state = {
            isAuthed: false,
            listenChannel: '',
        };
        clients.set(ws, state);

        console.info('A client connected.');
        console.info(`${clients.size} clients are now connected.`);

        ws.on('message', async function incoming(message) {
            await processMessage(ws, state, message);
        });

        ws.on('close', function close() {
            console.info('A client disconnected.');
            clients.delete(ws);
            console.info(`${clients.size} clients are now connected.`);
        });

        ws.on('error', (err) => {
            console.error('WebSocket error:', err);
            clients.delete(ws);
        });
    });
};
