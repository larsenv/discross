'use strict';
const WebSocket = require('ws');

const sockets = [];
const listenChannels = [];

function sendToAll(message, channel) {
  for (let i = 0; i < sockets.length; i++) {
    if (listenChannels[i] === channel) {
      sockets[i].send(message);
    }
  }
}

exports.sendToAll = sendToAll;

// Supported client→server WebSocket actions: AUTH (authenticate), LISTEN (subscribe to a channel).
function processMessage(isAuthed, listenChannel, message) {
  const action = message[0];
  const params = message.slice(action.length + 1, message.length);
  if (action === 'AUTH') {
    isAuthed = true;
  } else if (action === 'LISTEN') {
    // IMPORTANT TODO: Check channel permissions
    listenChannel = params;
  }
  return { isAuthed: isAuthed, listenChannel: listenChannel };
}

exports.startWsServer = function (server) {
  const wss = new WebSocket.Server({ server });
  wss.on('connection', function connection(ws) {
    const index = sockets.length;
    sockets.push(ws);
    listenChannels.push('');
    console.info('A client connected.');
    console.info(`${sockets.length} clients are now connected.`);
    let isAuthed = false;
    let listenChannel = '';

    ws.on('message', function incoming(message) {
      const response = processMessage(isAuthed, listenChannel, message);
      listenChannel = response.listenChannel;
      listenChannels[index] = response.listenChannel;
      isAuthed = response.isAuthed;
    });

    ws.on('close', function close() {
      console.info('A client disconnected.');
      const index = sockets.indexOf(ws);
      if (index > -1) {
        sockets.splice(index, 1);
        listenChannels.splice(index, 1);
      }
      console.info(`${sockets.length} clients are now connected.`);
    });
  });
};
