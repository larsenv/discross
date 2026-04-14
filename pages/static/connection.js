let connectiontype = 'none';
let latest_message_id = 0;
let messages = [];
const authkey = 'authpls';
let ws;
// nocache

function addMessage(text) {
    messages = messages.concat(text);

    // Safely render messages to prevent XSS attacks
    const myList = document.getElementById('myList');
    myList.innerHTML = '';

    for (let i = 0; i < messages.length; i++) {
        const node = document.createElement('div');
        const textnode = document.createTextNode(messages[i]);
        node.appendChild(textnode);
        myList.appendChild(node);

        // Add line break between messages except for the last one
        if (i < messages.length - 1) {
            myList.appendChild(document.createElement('br'));
        }
    }
}

function auth() {
    if (connectiontype == 'websocket') {
        send('AUTH ' + authkey);
    }
}

function send(message) {
    if (connectiontype == 'websocket') {
        ws.send(message);
    }
}

if (window.WebSocket || window.MozWebSocket) {
    if (!window.WebSocket) {
        window.WebSocket = window.MozWebSocket;
    }

    connectiontype = 'websocket';
    // Use ws:// for http and wss:// for https
    const wsProtocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(wsProtocol + location.host + '/');

    ws.onopen = function () {
        auth();
    };
    ws.onmessage = function (evt) {
        const received_msg = evt.data;
        addMessage(received_msg);
    };
}

let emojiShowing = false;
function showEmoji() {
    if (emojiShowing) {
        document.getElementById('emoji').style.display = 'none';
        emojiShowing = false;
    } else {
        document.getElementById('emoji').style.display = 'block';
        emojiShowing = true;
    }
}
