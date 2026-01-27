var connectiontype = "none";
var latest_message_id = 0;
var messages = [];
var isxhr = false;
var authkey = "authpls";
var time;
var xhttp;
var xhttp2;
var ws;
var retryCount = 0;
var maxRetryDelay = 30000; // 30 seconds max
// nocache

// https://stackoverflow.com/a/15339941
function Xhr() { /* returns cross-browser XMLHttpRequest, or null if unable */
  try {
    return new XMLHttpRequest();
  } catch (e) { }
  try {
    return new ActiveXObject("Msxml3.XMLHTTP");
  } catch (e) { }
  try {
    return new ActiveXObject("Msxml2.XMLHTTP.6.0");
  } catch (e) { }
  try {
    return new ActiveXObject("Msxml2.XMLHTTP.3.0");
  } catch (e) { }
  try {
    return new ActiveXObject("Msxml2.XMLHTTP");
  } catch (e) { }
  try {
    return new ActiveXObject("Microsoft.XMLHTTP");
  } catch (e) { }
  return null;
}

function addMessage(text) {
  messages = messages.concat(text);
  // console.log(text);
  // console.log(messages);
  
  // Safely render messages to prevent XSS attacks
  var myList = document.getElementById("myList");
  myList.innerHTML = "";  // Clear existing content
  
  for (var i = 0; i < messages.length; i++) {
    var node = document.createElement("div");
    var textnode = document.createTextNode(messages[i]);
    node.appendChild(textnode);
    myList.appendChild(node);
    
    // Add line break between messages except for the last one
    if (i < messages.length - 1) {
      myList.appendChild(document.createElement("br"));
    }
  }
}

function addLongpoll(id) {
  addScript("/longpoll.js?" + id, 'longpollScript');
}

function addScript(src, elementID) {
  if (isxhr) {
    xhttp2.open("GET", src, true);
    xhttp2.send(null);
  } else {
    document.getElementById(elementID).innerHTML = "";
    var script = document.createElement('script');
    script.setAttribute('src', src);
    document.getElementById(elementID).appendChild(script);
  }
}

function auth() {
  if (connectiontype == "websocket") {
    send("AUTH " + authkey);
  }
}

function send(message) {
  if (connectiontype == "none") {
  } else if (connectiontype == "websocket") {
    ws.send(message);
  } else if (connectiontype == "longpoll") {
    time = (new Date()).getTime().toString();



    // alert(encodeURIComponent("test"));



    // alert(encodeURIComponent(message));



    addScript('/api.js?uid=' +
      time +
      '&message=' +
      message
      + '&authkey=' +
      authkey,
      'apiScript');
  }
}

/* document.getElementById('messagebox').onkeypress = function(e){
  if (!e) e = window.event;
  var keyCode = e.keyCode || e.which;
  if (keyCode == '13' && document.getElementById('messagebox').value != ""){
    // alert("s");
    // Enter pressed
    send("SEND " + document.getElementById('messagebox').value);
    document.getElementById('messagebox').value = "";
    return false;
  }
} */

function myFunction(e) {
  if (e.preventDefault) {
    e.preventDefault();
  }
  send("SEND " + document.getElementById("messagebox").value);
  document.getElementById("messagebox").value = "";
  return false;
}

function longpoll_xhr(id) {
  xhttp.open("GET", "/longpoll-xhr?" + id + "&uid=" + (new Date()).getTime().toString(), true);
  xhttp.send(null);
}

function setup_xhr() {
  xhttp = Xhr();
  xhttp.onreadystatechange = function () {
    if (xhttp.readyState == 4) {
      // Check if request was successful
      if (xhttp.status === 200) {
        // Security: Parse JSON response instead of using eval()
        try {
          var response = JSON.parse(xhttp.responseText);
          if (response.latestMessageID !== undefined) {
            latest_message_id = response.latestMessageID;
          }
          if (response.messages && response.messages.length > 0) {
            for (var i = 0; i < response.messages.length; i++) {
              addMessage(response.messages[i]);
            }
          }
          // Reset retry count on success
          retryCount = 0;
          longpoll_xhr(latest_message_id);
        } catch (e) {
          console.error("Error parsing response:", e);
          // Retry with exponential backoff on parse error
          retryWithBackoff();
        }
      } else {
        // Server error - retry with exponential backoff
        console.error("Server returned status:", xhttp.status);
        retryWithBackoff();
      }
    }
  }
  xhttp.open("GET", "/longpoll-xhr?" + latest_message_id, true);
  xhttp.send(null);
}

function retryWithBackoff() {
  retryCount++;
  // Calculate delay: min(1000 * 2^retryCount, maxRetryDelay)
  var delay = Math.min(1000 * Math.pow(2, retryCount), maxRetryDelay);
  console.log("Retrying in " + delay + "ms (attempt " + retryCount + ")");
  setTimeout(function() {
    longpoll_xhr(latest_message_id);
  }, delay);
}

xhttp2 = Xhr();

// function WebSocketTest(usews) {




if (window.WebSocket || window.MozWebSocket) {







  if (!window.WebSocket) {




    window.WebSocket = window.MozWebSocket;




  }





  connectiontype = "websocket";
  // Let us open a web socket
  // Use ws:// for http and wss:// for https
  var wsProtocol = location.protocol === "https:" ? "wss://" : "ws://";
  ws = new WebSocket(wsProtocol + location.host + "/");

  ws.onopen = function () {
    auth();
    // Web Socket is connected, send data using send()
    // ws.send("Message to send");
    // alert("Message is sent...");
  };
  ws.onmessage = function (evt) {
    var received_msg = evt.data;
    addMessage(received_msg);
  };
  ws.onclose = function () {
    // websocket is closed.
    if (xhttp2) {
      connectiontype = "longpoll";
      // addLongpoll(latest_message_id);
      isxhr = false;
      // setup_xhr();
      // longpoll_xhr(latest_message_id);
    } else {
      connectiontype = "longpoll";
      isxhr = false;
      addLongpoll(latest_message_id);
      // setup_xhr();
      // longpoll_xhr(latest_message_id);
    }
  };
} else {
  // The browser doesn't support WebSocket maybe
  if (xhttp2) {
    connectiontype = "longpoll";
    // addLongpoll(latest_message_id);
    isxhr = false;
    // setup_xhr();
    // longpoll_xhr(latest_message_id);
  } else {
    connectiontype = "longpoll";
    isxhr = false;
    addLongpoll(latest_message_id);
    // setup_xhr();
    // longpoll_xhr(latest_message_id);
  }
}

var emojiShowing = false;
function showEmoji() {
  if (emojiShowing) {
    document.getElementById("emoji").style.display = "none";
    emojiShowing = false;
  } else {
    document.getElementById("emoji").style.display = "block";
    emojiShowing = true;
  }
}
