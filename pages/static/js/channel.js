for (var i = 0; i < 4; i++) {
    console.log('%cHold Up!', 'font-weight: bold; -webkit-text-fill-color: #5865f2; -webkit-text-stroke-width: 2px; -webkit-text-stroke-color: black; font-size: 71px;');
    console.log('%cIf someone told you to copy/paste something here you have an 11/10 chance you\'re being scammed.', 'font-size: 17px;');
    console.log('%cPasting anything in here could give attackers access to your Discross account.', 'color: red; font-weight: bold; font-size: 17px;');
}
console.log('%cUnless you understand exactly what you are doing, close this window and stay safe.', 'font-size: 17px;');
console.log('%cIf you do understand exactly what you are doing, you should come work with us http://discross.net/jobs/', 'font-size: 17px;');

function generateNonce() {
    try {
        if (window.crypto && window.crypto.getRandomValues) {
            var arr = new Uint32Array(3);
            window.crypto.getRandomValues(arr);
            return arr[0].toString(36) + arr[1].toString(36) + arr[2].toString(36);
        }
    } catch (e) {
        // Fall through to Math.random() fallback
    }
    return Math.random().toString(36).substring(2) + (new Date().getTime()).toString(36);
}

window.onload = function () {
    setTimeout(function() {
        window.location.hash = '';
        window.location.hash = 'end';
    }, 1000);
};

var emojiShowing = false;

function insertEmoji(code) {
    var input = document.getElementById('message');
    if (!input) return;
    if (input.value === '') {
        input.value = code;
    } else {
        input.value += ' ' + code;
    }
}

function showEmoji() {
    var emojiDiv = document.getElementById("emoji");
    if (!emojiDiv) return;
    
    if (emojiShowing) {
        emojiDiv.style.display = "none";
        emojiShowing = false;
    } else {
        emojiDiv.style.display = "";
        emojiShowing = true;
        try { emojiDiv.scrollIntoView(); } catch(e) { /* scrollIntoView not supported */ }
    }
    
    if (typeof updateToolbarPadding === 'function') {
        updateToolbarPadding();
    }
}

// Wrapped your orphaned file logic into a callable function
function handleFileSelection(input) {
    if (input && input.files && input.files[0]) {
        var file = input.files[0];
        var maxSize = 249 * 1024 * 1024; // 249MB limit
        
        if (file.size > maxSize) {
            alert('File is too large. Maximum size is 249MB.');
            input.value = '';
            return;
        }
        
        uploadFile(file);
    }
}

function sendMessageOrFile() {
    var nonceEl = document.getElementById('nonce');
    if (nonceEl) {
        nonceEl.value = generateNonce();
    }
    return true;
}

function uploadFile(file) {
    // Note: FormData and fetch() require modern browsers. 
    // They will fail natively on IE11 and below without polyfills.
    if (typeof FormData === 'undefined' || typeof fetch === 'undefined') {
        alert("Your browser is too old to upload files here.");
        return;
    }

    var formData = new FormData();
    formData.append('file', file);
    
    var channelEl = document.getElementById('channel');
    if (channelEl) {
        formData.append('channel', channelEl.value);
    }
    formData.append('message', ''); 

    function resetInput() {
        var fi = document.getElementById('fileUpload');
        if (fi) fi.value = '';
    }
    
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
        resetInput();
        if (data.success) {
            if (messageInput) messageInput.value = '';
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

function getHoverColor() {
    var cn = document.body.className || '';
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