// Security Warnings
// ================
(function () {
    var ua = navigator.userAgent;
    var isLegacy =
        /Nintendo (DSi|3DS|DS)|Nitro|Playstation [23]|PS[23]|PSP|Xbox( 360)?|Sega (Saturn|Dreamcast)/i.test(
            ua
        );

    if (isLegacy) return;

    for (var i = 0; i < 4; i++) {
        console.log(
            '%cHold Up!',
            'font-weight: bold; -webkit-text-fill-color: #5865f2; -webkit-text-stroke-width: 2px; -webkit-text-stroke-color: black; font-size: 71px;'
        );
        console.log(
            "%cIf someone told you to copy/paste something here you have an 11/10 chance you're being scammed.",
            'font-size: 17px;'
        );
        console.log(
            '%cPasting anything in here could give attackers access to your Discross account.',
            'color: red; font-weight: bold; font-size: 17px;'
        );
    }
    console.log(
        '%cUnless you understand exactly what you are doing, close this window and stay safe.',
        'font-size: 17px;'
    );
    console.log(
        '%cIf you do understand exactly what you are doing, you should come work with us http://discross.net/jobs/',
        'font-size: 17px;'
    );
})();

// Nonce Generation
// =============
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
    return Math.random().toString(36).substring(2) + new Date().getTime().toString(36);
}

// Page Scroll Helper (for manual actions like showing emoji)
// ==========================================================
function scrollToBottom() {
    var scrollHeight = Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0,
        999999
    );
    try {
        window.scrollTo(0, scrollHeight);
    } catch (e) {}
}

// Universal scroll-to-bottom on page load
// =======================================
// The #end anchor alone is unreliable: some legacy browsers drop URL fragments
// on redirects, and images that finish loading after the anchor jump push the
// page back up. Scroll as soon as the DOM is parsed (inline script at the end
// of the channel templates calls discrossScrollInit) and again on window.onload
// once images have settled. Skipped when the URL targets a specific message.
function shouldAutoScroll() {
    try {
        var h = window.location.hash;
        return !h || h === '#' || h === '#end';
    } catch (e) {
        return true;
    }
}

function discrossScrollInit() {
    if (shouldAutoScroll()) scrollToBottom();
}

(function () {
    var prevOnload = window.onload;
    window.onload = function () {
        if (prevOnload) {
            try {
                prevOnload();
            } catch (e) {}
        }
        discrossScrollInit();
    };
})();

// Message Box Insertion
// =====================

/**
 * Appends a token to the message box, keeping it separated by exactly one space
 * on each side: a leading space is added only when there's existing text that
 * doesn't already end in one, and a trailing space is always left behind so the
 * user can keep typing straight away.
 */
function appendToMessage(token) {
    var input = document.getElementById('message');
    if (!input || !token) return;

    if (input.value === '' || input.value.charAt(input.value.length - 1) === ' ') {
        input.value += token + ' ';
    } else {
        input.value += ' ' + token + ' ';
    }

    if (typeof autoResize === 'function') {
        autoResize(input);
    }
}

// Emoji System
// ==========
var emojiShowing = false;

function insertEmoji(code) {
    appendToMessage(code);
}

// Mentions
// ========

/**
 * Appends a mention (e.g. "@Some User") to the message box. Called when an
 * author's name is clicked in the message list.
 */
function insertMention(tag) {
    appendToMessage(tag);
}

// Reveals a text spoiler. The spoiler markup (discordMarkdown/spoiler.html)
// calls this from its onclick: the content starts with visibility:hidden and
// the box carries .spoiler-box, so we make the text visible and flip it into the
// .spoiler-revealed state the stylesheet paints. Image spoilers reveal
// themselves via their own inline handler and don't go through here.
function show(el) {
    if (!el) return;
    var spans = el.getElementsByTagName('span');
    for (var i = 0; i < spans.length; i++) {
        spans[i].style.visibility = 'visible';
    }
    if ((' ' + el.className + ' ').indexOf(' spoiler-revealed ') === -1) {
        el.className += (el.className ? ' ' : '') + 'spoiler-revealed';
    }
    el.style.cursor = 'auto';
    el.onclick = null;
}

function showEmoji() {
    var emojiDiv = document.getElementById('emoji');
    if (!emojiDiv) return;

    if (emojiShowing) {
        emojiDiv.style.display = 'none';
        emojiShowing = false;
    } else {
        emojiDiv.style.display = '';
        emojiShowing = true;

        try {
            emojiDiv.scrollIntoView();
        } catch (e) {
            scrollToBottom();
        }
        setTimeout(scrollToBottom, 50);
    }

    if (typeof updateToolbarPadding === 'function') {
        updateToolbarPadding();
    }
}

// File Selection Wrapper
// =====================
function handleFileSelect(input) {
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

function uploadFile(file) {
    var formData = new FormData();
    formData.append('file', file);
    formData.append('channel', document.getElementById('channel').value);
    formData.append('sessionID', document.getElementById('sessionID').value);

    var messageInput = document.getElementById('message');
    var originalPlaceholder = messageInput.placeholder;
    messageInput.disabled = true;
    messageInput.placeholder = 'Uploading: ' + file.name + '...';

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/uploadFile', true);

    xhr.onload = function () {
        messageInput.disabled = false;
        messageInput.placeholder = originalPlaceholder;
        if (xhr.status === 200) {
            var response = JSON.parse(xhr.responseText);
            if (response.success) {
                // Clear input and refocus
                messageInput.value = '';
                if (typeof autoResize === 'function') autoResize(messageInput);
                messageInput.focus();

                // Optional: Refresh message container to show the new message
                // For now, we rely on the user refreshing or the periodic refresh
            } else {
                alert('Upload failed: ' + response.error);
            }
        } else {
            alert('Upload failed with status ' + xhr.status);
        }
    };

    xhr.onerror = function () {
        messageInput.disabled = false;
        messageInput.placeholder = originalPlaceholder;
        alert('An error occurred during the upload.');
    };

    xhr.send(formData);
}

// Message Sending
// =============
function sendMessageOrFile() {
    var nonceEl = document.getElementById('nonce');
    if (nonceEl) {
        nonceEl.value = generateNonce();
    }
    return true;
}

// Color Helpers
// ============
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

function handleMessageKeydown(event) {
    var keyCode = event.keyCode || event.which;
    if (keyCode === 13 && !event.shiftKey) {
        event.preventDefault();
        var message = document.getElementById('message');
        if (message && message.value && message.value.replace(/^\s+|\s+$/g, '') !== '') {
            var form = message.form;
            if (typeof sendMessageOrFile === 'function') {
                if (sendMessageOrFile()) {
                    form.submit();
                }
            } else {
                form.submit();
            }
        }
        return false;
    }
}

function autoResize(el) {
    if (!el) return;

    var currentLen = el.value.length;
    var lastLen = parseInt(el.getAttribute('data-last-len') || '0');
    el.setAttribute('data-last-len', currentLen);

    // If growing, we can just use scrollHeight without resetting to auto
    if (currentLen > lastLen) {
        if (el.scrollHeight > el.offsetHeight && el.offsetHeight < 200) {
            var newHeight = Math.min(el.scrollHeight, 200);
            el.style.height = newHeight + 'px';
        }
    } else {
        // Shrinking or same length (potential wrap change)
        // Reset to auto to get natural height
        el.style.height = 'auto';
        var newHeight = el.scrollHeight;
        if (newHeight < 40) newHeight = 40;
        if (newHeight > 200) newHeight = 200;
        el.style.height = newHeight + 'px';
    }

    var overflow = el.scrollHeight > 200 ? 'auto' : 'hidden';
    if (el.style.overflowY !== overflow) {
        el.style.overflowY = overflow;
    }
}
