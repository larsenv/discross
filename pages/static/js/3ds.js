(function() {
    if (screen.height != 240) return;

    var msgContainer = document.getElementById('msgcontainer');
    if (!msgContainer) return;

    // Apply fixed positioning to the toolbar via JS
    var formContainers = document.getElementsByClassName('message-form-container');
    if (formContainers && formContainers.length > 0) {
        var toolbar = formContainers[0];
        toolbar.style.position = 'fixed';
        toolbar.style.bottom = '0px';
        toolbar.style.left = '0px';
        toolbar.style.height = '100%';
        toolbar.style.width = '100%';
        toolbar.style.backgroundColor = '#222327';
        toolbar.style.zIndex = '9999';
        toolbar.style.boxSizing = 'border-box';
    }

    // Wait for messages to load
    var check = setInterval(function() {
        if (msgContainer.children && msgContainer.children.length > 0) {
            clearInterval(check);
            
            // Add padding to the BOTTOM to force the browser to let you scroll 
            // past the fixed toolbar (150px gives a safe buffer for the ~80px toolbar)
            msgContainer.style.paddingBottom = '80px';
            
            // Single scroll 1 second (1000ms) after load
            setTimeout(function() {
                var targetScroll = (document.body ? document.body.scrollHeight : 999999) + 500;
                window.scrollTo(0, targetScroll);
            }, 3000);
        }
    }, 200);
})();