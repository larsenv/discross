'use strict';
/**
 * Real-time WebSocket connection handler for Discross.
 * Manages connected clients and pushes Discord messages to browsers.
 */
const WebSocket = require('ws');
const Redis = require('ioredis');

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
 * @property {string} [discordToken]
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
            const token = params.trim();
            if (token) {
                state.isAuthed = true;
                state.discordToken = token;
                state.sessionId = `session:${token}`;
                if (redis.status === 'ready') {
                    await redis.set(
                        state.sessionId,
                        JSON.stringify({
                            isAuthed: true,
                            listenChannel: state.listenChannel,
                            discordToken: token,
                        }),
                        'EX',
                        86400
                    ); // Expire in 24 hours
                }
            }
        } else if (action === 'LISTEN') {
            // IMPORTANT TODO: Check channel permissions
            state.listenChannel = params.trim();
            if (state.sessionId && redis.status === 'ready') {
                await redis.set(state.sessionId, JSON.stringify(state), 'EX', 86400);
            }
        } else if (action === 'RECONNECT') {
            const token = params.trim();
            if (redis.status === 'ready') {
                const sessionData = await redis.get(`session:${token}`);
                if (sessionData) {
                    const parsed = JSON.parse(sessionData);
                    state.isAuthed = parsed.isAuthed;
                    state.listenChannel = parsed.listenChannel;
                    state.discordToken = parsed.discordToken;
                    state.sessionId = `session:${token}`;
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
