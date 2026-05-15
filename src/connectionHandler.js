'use strict';
/**
 * Real-time WebSocket connection handler for Discross.
 * Manages connected clients and pushes Discord messages to browsers.
 */
const WebSocket = require('ws');

// Use a Map to associate WebSocket instances with their subscription state.
// This avoids indexing bugs when clients disconnect and shift array positions.
const clients = new Map();

function sendToAll(message, channel) {
    for (const [socket, state] of clients.entries()) {
        if (state.listenChannel === channel) {
            socket.send(message);
        }
    }
}

exports.sendToAll = sendToAll;

// Supported client→server WebSocket actions: AUTH (authenticate), LISTEN (subscribe to a channel).
function processMessage(state, message) {
    const msgStr = message.toString();
    const parts = msgStr.split(' ');
    const action = parts[0];
    const params = parts.slice(1).join(' ');

    if (action === 'AUTH') {
        state.isAuthed = true;
    } else if (action === 'LISTEN') {
        // IMPORTANT TODO: Check channel permissions
        state.listenChannel = params.trim();
    }
    return state;
}

exports.startWsServer = function (server) {
    const wss = new WebSocket.Server({ server });
    wss.on('connection', function connection(ws) {
        // Initialize state for the new client
        const state = {
            isAuthed: false,
            listenChannel: '',
        };
        clients.set(ws, state);

        console.info('A client connected.');
        console.info(`${clients.size} clients are now connected.`);

        ws.on('message', function incoming(message) {
            processMessage(state, message);
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
