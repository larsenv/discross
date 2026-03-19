for (let i = 0; i < 4; i++) {
    console.log('%cHold Up!', 'font-weight: bold; -webkit-text-fill-color: #5865f2; -webkit-text-stroke-width: 2px; -webkit-text-stroke-color: black; font-size: 71px;');
    console.log('%cIf someone told you to copy/paste something here you have an 11/10 chance you\'re being scammed.', 'font-size: 17px;');
    console.log('%cPasting anything in here could give attackers access to your Discross account.', 'color: red; font-weight: bold; font-size: 17px;');
}
console.log('%cUnless you understand exactly what you are doing, close this window and stay safe.', 'font-size: 17px;');
console.log('%cIf you do understand exactly what you are doing, you should come work with us http://discross.net/jobs/', 'font-size: 17px;');

// Generate a unique nonce for duplicate message prevention.
// Uses crypto.getRandomValues when available (modern browsers) and falls back
// to Math.random() combined with the current timestamp for older browsers.
function generateNonce() {
    try {
        if (window.crypto && window.crypto.getRandomValues) {
            const arr = new Uint32Array(3);
            window.crypto.getRandomValues(arr);
            return arr[0].toString(36) + arr[1].toString(36) + arr[2].toString(36);
        }
    } catch (e) {
        // Fall through to Math.random() fallback
    }
    return Math.random().toString(36).substring(2) + (new Date().getTime()).toString(36);
}

window.onload = function () {
    // Generate a unique nonce for this page load to prevent duplicate message sends
    var nonceEl = document.getElementById('nonce');
    if (nonceEl) {
        nonceEl.value = generateNonce();
    }

    // Set padding initially
    updateToolbarPadding();

    // Update on resize (debounce slightly for performance)
    var resizeTimer;
    function onResize() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(updateToolbarPadding, 100);
    }

    if (window.addEventListener) {
        window.addEventListener('resize', onResize);
        window.addEventListener('orientationchange', onResize);
    }

    // Enhanced scroll-to-bottom for old browser compatibility
    function scrollToBottom() {
        const end = document.getElementById("end");
        const msgContainer = document.getElementById("msgcontainer");
        const scrollContainer = msgContainer ? msgContainer.parentNode : null;
        
        // Try multiple scroll methods for maximum compatibility
        let scrolled = false;
        
        // Method 1: scrollIntoView on #end element (modern browsers)
        if (end && end.scrollIntoView) {
            try {
                end.scrollIntoView();
                scrolled = true;
            } catch (e) {
                // Continue to fallback methods
            }
        }
        
        // Method 2: Scroll the container holding msgcontainer
        if (!scrolled && scrollContainer && scrollContainer.scrollTop !== undefined) {
            try {
                scrollContainer.scrollTop = scrollContainer.scrollHeight;
                scrolled = true;
            } catch (e) {
                // Continue to fallback methods
            }
        }
        
        // Method 3: Scroll msgcontainer itself
        if (!scrolled && msgContainer && msgContainer.scrollTop !== undefined) {
            try {
                msgContainer.scrollTop = msgContainer.scrollHeight;
                scrolled = true;
            } catch (e) {
                // Continue to fallback methods
            }
        }
        
        // Method 4: Scroll window to #end anchor (old browser fallback)
        if (!scrolled && end) {
            try {
                window.location.hash = 'end';
                scrolled = true;
            } catch (e) {
                // Final fallback - scroll window to bottom
                try {
                    window.scrollTo(0, document.body.scrollHeight);
                } catch (e2) {
                    // If all else fails, at least try basic body scroll
                    document.body.scrollTop = document.body.scrollHeight;
                }
            }
        }

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
    }
    
    scrollToBottom();
};

let emojiShowing = false;

function insertEmoji(code) {
    const input = document.getElementById('message');
    if (input.value === '') {
        input.value = code;
    } else {
        input.value += ' ' + code;
    }
}

function showEmoji() {
    const emojiDiv = document.getElementById("emoji");
    if (emojiShowing) {
        emojiDiv.style.display = "none";
        emojiShowing = false;
    } else {
        emojiDiv.style.display = "";
        emojiShowing = true;
        try { emojiDiv.scrollIntoView(); } catch(e) { /* scrollIntoView not supported */ }
    }
    // Update padding based on new toolbar height
    updateToolbarPadding();
}

// Spoiler reveal function for Wii compatibility
function show(el) {
  try {
    // Add revealed class (CSS handles per-theme revealed background)
    if (!el.classList.contains('spoiler-revealed')) {
      el.classList.add('spoiler-revealed');
    }
    // Also set inline background for older browsers that don't support class-based CSS
    let revealedBg;
    if (document.body.classList.contains('light-theme')) {
      revealedBg = '#efeff0';
    } else if (document.body.classList.contains('amoled-theme')) {
      revealedBg = '#1d1d20';
    } else {
      revealedBg = '#26262b';
    }
    el.style.background = revealedBg;
    // Find and reveal hidden spoiler content (first span with visibility:hidden)
    const hiddenSpan = el.querySelector('span[style*="visibility:hidden"], span[style*="visibility: hidden"]');
    if (hiddenSpan) {
      hiddenSpan.style.visibility = 'visible';
    }
      el.style.background = '#efeff0';
    } else if (document.body.classList.contains('amoled-theme')) {
      el.style.background = '#1d1d20';
    } else {
      el.style.background = '#26262b';
    }
  }
}    if (input.files && input.files[0]) {
        const file = input.files[0];
        const maxSize = 249 * 1024 * 1024; // 249MB limit for transfer.whalebone.io
        
        if (file.size > maxSize) {
            alert('File is too large. Maximum size is 249MB.');
            input.value = '';
            return;
        }
        
        // Upload file immediately using fetch
        uploadFile(file);
    }
}

function sendMessageOrFile() {
    // Refresh the nonce before each submission so retries get a fresh token
    const nonceEl = document.getElementById('nonce');
    if (nonceEl) {
        nonceEl.value = generateNonce();
    }
    // Files are uploaded immediately on selection, so just allow normal form submission for text messages
    return true;
}

function uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('channel', document.getElementById('channel').value);
    formData.append('message', ''); // No message content, just the file URL

    function resetInput() {
        var fi = document.getElementById('fileUpload');
        if (fi) fi.value = '';
    }
    
    // Show uploading indicator
    const messageInput = document.getElementById('message');
    const originalValue = messageInput ? messageInput.value : '';
    if (messageInput) {
        messageInput.disabled = true;
        messageInput.value = 'Uploading ' + file.name + '...';
    }
    
    fetch('/uploadFile', {
        method: 'POST',
        body: formData
    })
    .then(function(response) {
        return response.json();
    })
    .then(function(data) {
        resetInput();
        if (data.success) {
            // Clear message box before refreshing
            if (messageInput) {
                messageInput.value = '';
            }
            // Refresh page when upload is done
            window.location.reload();
        } else {
            alert('Upload failed: ' + (data.error || 'Unknown error'));
            if (messageInput) {
                messageInput.value = originalValue;
                messageInput.disabled = false;
            }
        }
    })
    .catch(function(error) {
        resetInput();
        alert('Upload failed: ' + error);
        if (messageInput) {
            messageInput.value = originalValue;
            messageInput.disabled = false;
        }
    });
}

// Theme-aware hover color helper
// Use className.indexOf instead of classList.contains for IE8/Opera 9.x compatibility
// Use solid colors as primary values so IE8 (which doesn't support rgba) still shows hover
function getHoverColor() {
    var cn = document.body.className;
    if (cn.indexOf('light-theme') !== -1) {
        return '#ebebeb';
    } else if (cn.indexOf('amoled-theme') !== -1) {
        return '#222';
    } else {
        return '#444';
    }
}

function setHoverBg(el) {
    el.style.background = getHoverColor();
}

function clearBg(el) {
    el.style.background = 'none';
}
