const WebSocket = require('ws')

let wss

const sockets = []
const listenChannels = []

const messages = []
const MAX_MESSAGES = 1000
let latestMessageID = 0

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function sendToAll(message, channel) {
  for (let i = 0; i < sockets.length; i++) {
    if (listenChannels[i] === channel) {
      sockets[i].send(message)
    }
  }
}

exports.sendToAll = sendToAll

function processMessage(connectionType, isAuthed, listenChannel, message) {
  const action = message[0]
  const params = message.slice(action.length + 1, message.length)
  if (action === 'AUTH' && connectionType === 'websockets') { // IMPORTANT TODO: Add proper auth!
    if (params === 'authpls') {
      sendToAll('Authed!')
    }
  } else if (action === 'SEND') {
    if (isAuthed || connectionType === 'longpoll') {
      sendToAll('<circuit10> ' + params)
      messages.push(params)
      latestMessageID += 1
      // Keep messages array bounded so it doesn't grow forever
      if (messages.length > MAX_MESSAGES) {
        messages.shift()
      }
    } else {
      sendToAll('Please log in')
    }
  } else if (action === 'LISTEN') { // IMPORTANT TODO: Check channel permissions
    listenChannel = params
  }
  return { isAuthed: isAuthed, listenChannel: listenChannel }
}

exports.processRequest = async function (req, res) {
  const parsedurl = new URL(req.url, 'http://localhost')
  if (parsedurl.pathname === '/longpoll.js') {
    const initialID = Number(req.url.slice(13, req.url.length));
    res.write('latestMessageID = ' + JSON.stringify(latestMessageID) + '; addMessage(' + JSON.stringify(messages.slice(initialID, messages.length)) + '); addLongpoll(latestMessageID);')
  } else if (parsedurl.pathname === '/longpoll-xhr') {
    let initialID = Number(req.url.slice(14, req.url.length).split('&')[0])
    while (initialID >= latestMessageID) {
      await sleep(25)
    }
    // Security: Return JSON instead of JavaScript code
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.write(JSON.stringify({
      latestMessageID: latestMessageID,
      messages: messages.slice(initialID, messages.length)
    }))
  } else if (parsedurl.pathname === '/api.js') {
    processMessage('longpoll', true, '', parsedurl.searchParams.get('message'))
  } else {
    res.writeHead(404)
    res.write('404 not found')
  }
  res.end()
}

exports.startWsServer = function (server) {
  wss = new WebSocket.Server({ server })

  wss.on('connection', function connection(ws) {
    const index = sockets.length
    sockets.push(ws)
    listenChannels.push('')
    console.log('A client connected.')
    console.log(sockets.length + ' clients are now connected.')
    let isAuthed = false
    let listenChannel = ''

    ws.on('message', function incoming(message) {
      const response = processMessage('websockets', isAuthed, listenChannel, message)
      listenChannel = response.listenChannel
      listenChannels[index] = response.listenChannel
      isAuthed = response.isAuthed
    })

    ws.on('close', function close() {
      console.log('A client disconnected.')
      const index = sockets.indexOf(ws)
      if (index > -1) {
        sockets.splice(index, 1)
        listenChannels.splice(index, 1)
      }
      console.log(sockets.length + ' clients are now connected.')
    })
  })
}
