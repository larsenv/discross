var connectiontype = 'none';
var latest_message_id = 0;
var messages = [];
var authkey = 'authpls';
var ws;
// nocache

function addMessage(text) {
    messages = messages.concat(text);

    // Safely render messages to prevent XSS attacks
    var myList = document.getElementById('myList');
    if (!myList) return;
    myList.innerHTML = '';

    for (var i = 0; i < messages.length; i++) {
        var node = document.createElement('div');
        var textnode = document.createTextNode(messages[i]);
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
    var wsProtocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(wsProtocol + location.host + '/');

    ws.onopen = function () {
        auth();
    };
    ws.onmessage = function (evt) {
        var received_msg = evt.data;
        addMessage(received_msg);
    };
}

var emojiShowing = false;
function showEmoji() {
    var emojiDiv = document.getElementById('emoji');
    if (!emojiDiv) return;
    
    if (emojiShowing) {
        emojiDiv.style.display = 'none';
        emojiShowing = false;
    } else {
        emojiDiv.style.display = 'block';
        emojiShowing = true;
    }
}

