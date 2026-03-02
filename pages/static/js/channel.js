for (var i = 0; i < 4; i++) {
    console.log('%cHold Up!', 'font-weight: bold; -webkit-text-fill-color: #5865f2; -webkit-text-stroke-width: 2px; -webkit-text-stroke-color: black; font-size: 71px;');
    console.log('%cIf someone told you to copy/paste something here you have an 11/10 chance you\'re being scammed.', 'font-size: 17px;');
    console.log('%cPasting anything in here could give attackers access to your Discross account.', 'color: red; font-weight: bold; font-size: 17px;');
}
console.log('%cUnless you understand exactly what you are doing, close this window and stay safe.', 'font-size: 17px;');
console.log('%cIf you do understand exactly what you are doing, you should come work with us http://discross.net/jobs/', 'font-size: 17px;');
window.onload = function () {
    // Enhanced scroll-to-bottom for old browser compatibility
    function scrollToBottom() {
        var end = document.getElementById("end");
        var msgContainer = document.getElementById("msgcontainer");
        var scrollContainer = msgContainer ? msgContainer.parentNode : null;
        
        // Try multiple scroll methods for maximum compatibility
        var scrolled = false;
        
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
    }
    
    scrollToBottom();
};

var emojiShowing = false;

function insertEmoji(code) {
    var input = document.getElementById('message');
    if (input.value === '') {
        input.value = code;
    } else {
        input.value += ' ' + code;
    }
}

function showEmoji() {
    var emojiDiv = document.getElementById("emoji");
    if (emojiShowing) {
        emojiDiv.style.display = "none";
        emojiShowing = false;
    } else {
        emojiDiv.style.display = "";
        emojiShowing = true;
        try { emojiDiv.scrollIntoView(); } catch(e) { /* scrollIntoView not supported */ }
    }
}

// Spoiler reveal function for Wii compatibility
function show(el) {
    try {
        el.style.background = "none";
        // Navigate the DOM structure: table -> tbody -> tr -> td -> font
        var tbody = el.childNodes[0];
        if (tbody && tbody.childNodes && tbody.childNodes[0]) {
            var tr = tbody.childNodes[0];
            if (tr && tr.childNodes && tr.childNodes[0]) {
                var td = tr.childNodes[0];
                if (td && td.childNodes && td.childNodes[0]) {
                    var font = td.childNodes[0];
                    if (font && font.style) {
                        font.style.visibility = "visible";
                    }
                }
            }
        }
    } catch (e) {
        // Fallback: just remove background if structure is unexpected
        el.style.background = "none";
    }
}

// File upload handling - integrated with send button
function openFileUpload() {
    var channelId = document.getElementById('channel').value;
    var url = '/upload?channel=' + encodeURIComponent(channelId);
    var sessionEl = document.getElementById('sessionID');
    if (sessionEl && sessionEl.value) {
        url += '&sessionID=' + encodeURIComponent(sessionEl.value);
    }
    window.location.href = url;
}

function handleFileSelect(input) {
    if (input.files && input.files[0]) {
        var file = input.files[0];
        var maxSize = 249 * 1024 * 1024; // 249MB limit for transfer.whalebone.io
        
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
    // Files are uploaded immediately on selection, so just allow normal form submission for text messages
    return true;
}

function uploadFile(file) {
    var formData = new FormData();
    formData.append('file', file);
    formData.append('channel', document.getElementById('channel').value);
    formData.append('message', ''); // No message content, just the file URL
    
    // Show uploading indicator
    var messageInput = document.getElementById('message');
    var originalValue = messageInput ? messageInput.value : '';
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
        alert('Upload failed: ' + error);
        if (messageInput) {
            messageInput.value = originalValue;
            messageInput.disabled = false;
        }
    })
    .finally(function() {
        document.getElementById('fileUpload').value = '';
    });
}

// Theme-aware hover color helper
function getHoverColor() {
    if (document.body.classList.contains('light-theme')) {
        return 'rgba(0, 0, 0, 0.08)';
    } else if (document.body.classList.contains('amoled-theme')) {
        return 'rgba(255, 255, 255, 0.08)';
    } else {
        return 'rgba(255, 255, 255, 0.06)';
    }
}

function setHoverBg(el) {
    el.style.background = getHoverColor();
}

function clearBg(el) {
    el.style.background = 'none';
}
