// Development auto-reload for Discross - triggers browser refresh when server restarts
(function() {
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    const ws = new WebSocket('ws://' + window.location.host);
    ws.onmessage = function(event) {
      if (event.data === 'reload') {
        window.location.reload();
      }
    };
    ws.onclose = function() {
      setTimeout(function() {
        window.location.reload();
      }, 1000);
    };
  }
})();
