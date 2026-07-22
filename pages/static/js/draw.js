var canvas = document.getElementById('sketchpad');
var ctx = canvas.getContext('2d');

// Detect device capability tiers:
// DSi (screen.width <= 256): very slow, needs batched rendering + small canvas
// Old 3DS and similar (screen.width <= 320): needs small canvas + immediate draw
var _ua = navigator.userAgent.toLowerCase();
var isDSi =
    (screen.width && screen.width <= 256) ||
    _ua.indexOf('nintendo dsi') !== -1 ||
    _ua.indexOf('dsi') !== -1;
var isSlowDevice = (screen.width && screen.width <= 320) || isDSi;
var isWii =
    (_ua.indexOf('nintendo wii') !== -1 || _ua.indexOf('wii') !== -1) && _ua.indexOf('wiiu') === -1;
var is3DS = _ua.indexOf('nintendo 3ds') !== -1;
var isNew3DS = is3DS && _ua.indexOf('nintendobrowser') !== -1;
var isOld3DS = is3DS && !isNew3DS;

// On small screens, shrink the canvas backing buffer before any drawing.
// 240×140 has the same 12:7 aspect ratio as 600×350 but only ~33,600 pixels
// vs 210,000 — roughly 6× fewer, making drawing usable on legacy hardware.
// This must happen BEFORE ctx operations (resizing canvas resets its content).
if (isSlowDevice) {
    canvas.width = 240;
    canvas.height = 140;
}

var isDrawing = false;
var lastX = 0;
var lastY = 0;
var currColor = '#000000';
var currSize = 5;
var currTool = 'draw';

// History for undo
var historyStack = [];
var maxHistory = 20;

function saveHistory() {
    if (isSlowDevice || isWii || isDSi) return; // getImageData too expensive for Old 3DS / DSi / Wii
    try {
        if (historyStack.length >= maxHistory) {
            historyStack.shift();
        }
        historyStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    } catch (ex) {}
}

function undo() {
    if (historyStack.length > 0) {
        ctx.putImageData(historyStack.pop(), 0, 0);
    }
}

// Point queue for batched rendering.
// Instead of calling ctx.stroke() on every mousemove (one repaint per event,
// which is very slow on DSi Opera 9.5), we accumulate points here and flush
// them all in a single stroke() call at a fixed interval.
var pointQueue = [];
var lastDrawnX = 0;
var lastDrawnY = 0;

// Defaults
ctx.lineCap = 'round';
ctx.lineJoin = 'round';
ctx.lineWidth = currSize;
ctx.strokeStyle = currColor;
// Fill canvas with white immediately (transparent canvas turns black on some Wii conversions)
ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.fillStyle = currColor;

// Canvas display dimensions (CSS pixels). Stored explicitly so coordinate
// calculations don't rely on canvas.offsetWidth, which on older Opera (DSi)
// incorrectly returns the HTML attribute value (600) instead of the actual
// CSS-constrained display width, causing a 2-3x coordinate scaling error.
var canvasDisplayW = canvas.width;
var canvasDisplayH = canvas.height;

// --- CANVAS DISPLAY RESIZE ---
// Explicitly set the canvas element's CSS width and height to maintain
// aspect ratio on small screens. CSS height:auto is unreliable on
// <canvas> in older browsers (DSi/3DS NetFront/WebKit).
function resizeCanvasDisplay() {
    if (isWii) return; // Wii uses fixed 600x350 canvas without CSS resize
    var wrapper = document.getElementById('canvas-wrapper');
    // Subtract 10px to account for the 5px padding on each side of #canvas-wrapper
    var maxW = wrapper ? wrapper.offsetWidth - 10 : 0;
    if (maxW > 150 && maxW < canvas.width) {
        var ratio = maxW / canvas.width;
        canvasDisplayW = maxW;
        canvasDisplayH = Math.round(canvas.height * ratio);
        canvas.style.width = canvasDisplayW + 'px';
        canvas.style.height = canvasDisplayH + 'px';
    } else if (maxW > 150) {
        canvasDisplayW = canvas.width;
        canvasDisplayH = canvas.height;
        canvas.style.width = '';
        canvas.style.height = '';
    }
    // If maxW <= 150 layout isn't ready yet or collapsed; values stay at default
}
resizeCanvasDisplay();
// Also run on load to catch any layout changes after inline execution
if (window.addEventListener) {
    window.addEventListener('load', resizeCanvasDisplay, false);
    window.addEventListener('resize', resizeCanvasDisplay, false);
} else if (window.attachEvent) {
    window.attachEvent('onload', resizeCanvasDisplay);
    window.attachEvent('onresize', resizeCanvasDisplay);
}

// --- COORDINATE SYSTEM ---
// Primary: e.offsetX/offsetY — coordinates relative to the canvas element.
// Available in Opera 9+ (DSi browser), Chrome, Safari, IE9+.
// No scroll correction or element-position traversal needed.
//
// Fallback (Firefox <39 and other browsers without offsetX):
// Use pageX/pageY (document-relative) + canvas document-offset traversal.
function getCanvasPagePos() {
    var left = 0,
        top = 0;
    var el = canvas;
    while (el) {
        left += el.offsetLeft || 0;
        top += el.offsetTop || 0;
        el = el.offsetParent;
    }
    return { left: left, top: top };
}

function getScrollOffset() {
    var sx, sy;
    if (window.pageXOffset !== undefined) {
        sx = window.pageXOffset;
        sy = window.pageYOffset;
    } else if (document.documentElement && document.documentElement.scrollLeft !== undefined) {
        sx = document.documentElement.scrollLeft;
        sy = document.documentElement.scrollTop;
    } else {
        sx = document.body.scrollLeft || 0;
        sy = document.body.scrollTop || 0;
    }
    return { x: sx, y: sy };
}

function getPos(e) {
    e = e || window.event || {};
    // Modern browsers, Wii Opera 9, & New 3DS: e.offsetX/offsetY
    if (e.offsetX !== undefined) {
        return {
            x: e.offsetX * (canvas.width / canvasDisplayW),
            y: e.offsetY * (canvas.height / canvasDisplayH)
        };
    }
    // Wii Opera 9 and browsers without offsetX: use getBoundingClientRect if available
    if (canvas.getBoundingClientRect && e.clientX !== undefined) {
        var rect = canvas.getBoundingClientRect();
        var scaleX = rect.width ? canvas.width / rect.width : 1;
        var scaleY = rect.height ? canvas.height / rect.height : 1;
        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY
        };
    }
    // Fallback: pageX/pageY + canvas page offset
    var scroll = getScrollOffset();
    var pageX = e.pageX !== undefined ? e.pageX : e.clientX + scroll.x;
    var pageY = e.pageY !== undefined ? e.pageY : e.clientY + scroll.y;
    var cp = getCanvasPagePos();
    return {
        x: (pageX - cp.left) * (canvas.width / canvasDisplayW),
        y: (pageY - cp.top) * (canvas.height / canvasDisplayH)
    };
}

// --- BATCHED RENDERING ---
// Flush all queued line segments in a single stroke() call.
// This is the key DSi performance fix: each ctx.stroke() triggers a full
// canvas repaint in Opera 9.5, so we batch many segments into one repaint
// instead of one repaint per mousemove event.
function flushDrawQueue() {
    if (pointQueue.length === 0) return;
    ctx.beginPath();
    ctx.moveTo(lastDrawnX, lastDrawnY);
    for (var i = 0; i < pointQueue.length; i++) {
        ctx.lineTo(pointQueue[i].x, pointQueue[i].y);
    }
    ctx.stroke();
    var last = pointQueue[pointQueue.length - 1];
    lastDrawnX = last.x;
    lastDrawnY = last.y;
    pointQueue = [];
}
// Flush batched draw calls at ~33fps via setInterval.
// The DSi mouse path is now the ONLY thing that fills pointQueue — every other
// path (Wii, New 3DS, Old 3DS, desktop, touch) draws each segment immediately.
// A 33x/sec timer that only ever calls a function returning on its first line is
// pure overhead on these slow CPUs and steals cycles from the move handler, so
// only start it where the queue is actually used.
if (isDSi) {
    setInterval(flushDrawQueue, 30);
}

function onCanvasMouseDown(e) {
    e = e || window.event;
    if (e && e.preventDefault) e.preventDefault(); // Stop Wii drag-to-scroll

    var pos = getPos(e);
    if (currTool === 'fill') {
        saveHistory();
        floodFill(pos.x, pos.y);
        return false;
    }

    saveHistory();
    isDrawing = true;
    lastX = pos.x;
    lastY = pos.y;
    lastDrawnX = pos.x;
    lastDrawnY = pos.y;
    pointQueue = [];

    // Draw a dot at click/tap position for immediate feedback
    ctx.beginPath();
    ctx.arc(lastX, lastY, currSize / 2, 0, Math.PI * 2, false);
    ctx.fillStyle = currTool === 'eraser' ? '#ffffff' : currColor;
    ctx.strokeStyle = currTool === 'eraser' ? '#ffffff' : currColor;
    ctx.fill();
    ctx.beginPath();

    return false;
}

function onCanvasMouseMove(e) {
    if (!isDrawing) return;
    e = e || window.event;
    if (e && e.preventDefault) e.preventDefault();

    var pos = getPos(e);
    if (isDSi) {
        // DSi Opera 9.5 only: each ctx.stroke() forces a full-canvas repaint, so
        // batch segments into the queue and let setInterval(flushDrawQueue) paint
        // them ~33fps. Faster engines (New 3DS, Wii U, desktop) must NOT go through
        // the queue — their setInterval is clamped under drawing load and flushes
        // only ~1-2x/sec, which is the "responds every half second" lag. They draw
        // immediately here instead, matching the pre-July-10 fast path.
        pointQueue.push({ x: pos.x, y: pos.y });
    } else {
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(pos.x, pos.y);
        ctx.stroke();
    }
    lastX = pos.x;
    lastY = pos.y;
}

function onCanvasMouseUp(e) {
    e = e || window.event;
    flushDrawQueue();
    isDrawing = false;
}

// --- EVENT BINDING ---
// Wii Opera 9.0/9.3 and DSi Opera 9.5: addEventListener with useCapture is unreliable
// on target elements in older Presto engines. DOM0 handlers (canvas.onXxx) work
// reliably and allow returning false to prevent the browser's native drag-scroll.
// All other browsers use addEventListener.
function drawInterpolatedLine(x0, y0, x1, y1) {
    var dx = x1 - x0;
    var dy = y1 - y0;
    var distance = Math.sqrt(dx * dx + dy * dy);
    var steps = Math.max(1, Math.floor(distance / 2));
    var col = currTool === 'eraser' ? '#ffffff' : currColor;
    ctx.fillStyle = col;
    for (var i = 0; i <= steps; i++) {
        var t = i / steps;
        var x = x0 + dx * t;
        var y = y0 + dy * t;
        ctx.beginPath();
        ctx.arc(x, y, currSize / 2, 0, Math.PI * 2, false);
        ctx.fill();
    }
    ctx.beginPath();
}

// --- WII COORDINATE SYSTEM ---
// The Wii Internet Channel runs Opera 9 (Presto), which does NOT implement
// event.offsetX/offsetY and whose getBoundingClientRect is unreliable/absent.
// It DOES expose the Netscape/Presto-era event.layerX/layerY, relative to the
// nearest positioned ancestor (#canvas-wrapper). This restores the exact
// coordinate-resolution chain that drew correctly on the Wii in January
// (offsetX -> layerX -> getBoundingClientRect -> page-offset walk); the shared
// getPos() had layerX removed in the Mar 1 "canvas scale factor" rewrite, which
// silently broke Wii drawing because none of its remaining branches produce
// usable coordinates on Opera 9. Kept separate from getPos() so 3DS/DSi/desktop
// paths are untouched. No CSS scale factor: the Wii shows the canvas at its
// native 600x350 (resizeCanvasDisplay() no-ops for Wii).
function getWiiPos(e) {
    e = e || window.event || {};
    // Use offsetX only when truthy — Opera 9 leaves it undefined, and a bogus 0
    // should fall through rather than pin every stroke to the top-left.
    if (e.offsetX) {
        return { x: e.offsetX, y: e.offsetY };
    }
    // Opera 9 / old Gecko: layerX/layerY relative to the positioned wrapper.
    if (e.layerX !== undefined && e.layerX !== null) {
        return { x: e.layerX, y: e.layerY };
    }
    // Newer Presto builds that gained getBoundingClientRect — guard the call so
    // an absent implementation can't throw out of the drawing handler.
    if (canvas.getBoundingClientRect && e.clientX !== undefined) {
        var rect = canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }
    // Last resort: document-relative pointer coords minus the canvas's page offset.
    var scroll = getScrollOffset();
    var pageX = e.pageX !== undefined ? e.pageX : e.clientX + scroll.x;
    var pageY = e.pageY !== undefined ? e.pageY : e.clientY + scroll.y;
    var cp = getCanvasPagePos();
    return { x: pageX - cp.left, y: pageY - cp.top };
}

if (isWii) {
    // Wii Opera 9: draw immediately per mousemove using moveTo/lineTo/stroke
    // matching commit ed4d3a1b65fce4c8caec0a44da9738470c84c932
    canvas.onmousedown = function (e) {
        e = e || window.event;
        if (e && e.preventDefault) e.preventDefault();
        isDrawing = true;
        var pos = getWiiPos(e);

        if (currTool === 'fill') {
            // floodFill needs getImageData/putImageData, which older Wii Opera builds
            // may not support — guard so a failed Fill doesn't throw out of the handler.
            try {
                floodFill(pos.x, pos.y);
            } catch (ex) {}
            return false;
        }

        saveHistory();
        lastX = pos.x;
        lastY = pos.y;

        // Set the stroke colour once per stroke rather than on every mousemove —
        // colour/tool can't change mid-drag, and a property write per move is
        // wasted work on the Wii's CPU.
        ctx.strokeStyle = currTool === 'eraser' ? '#ffffff' : currColor;
        ctx.fillStyle = ctx.strokeStyle;

        ctx.beginPath();
        ctx.arc(lastX, lastY, currSize / 2, 0, Math.PI * 2, false);
        ctx.fill();
        ctx.beginPath();

        return false;
    };
    canvas.onmousemove = function (e) {
        // The Wii pointer fires mousemove constantly, even when A isn't held, so
        // bail before doing any work when we're not mid-stroke.
        if (!isDrawing) return;
        e = e || window.event;
        if (e && e.preventDefault) e.preventDefault();

        var pos = getWiiPos(e);
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(pos.x, pos.y);
        ctx.stroke(); // strokeStyle already set on mousedown
        lastX = pos.x;
        lastY = pos.y;
    };
    canvas.onmouseup = function () {
        isDrawing = false;
    };
    canvas.onmouseout = function () {
        isDrawing = false;
    };
} else if (isDSi) {
    // DSi Opera 9.5: keep DOM0 handlers but use the batched queue approach
    // since each ctx.stroke() triggers a full canvas repaint on this slower device.
    canvas.onmousedown = function (e) {
        e = e || window.event;
        return onCanvasMouseDown(e);
    };
    canvas.onmousemove = function (e) {
        if (!isDrawing) return false;
        e = e || window.event;
        onCanvasMouseMove(e);
        return false;
    };
    canvas.onmouseup = function (e) {
        e = e || window.event;
        onCanvasMouseUp(e);
        return false;
    };
    canvas.onmouseout = function (e) {
        e = e || window.event;
        onCanvasMouseUp(e);
        return false;
    };
} else {
    canvas.addEventListener('mousedown', onCanvasMouseDown, true);
    canvas.addEventListener('mouseup', onCanvasMouseUp, true);
    canvas.addEventListener('mouseout', onCanvasMouseUp, true);
    // Old 3DS (SPIDER): mousemove may fire at document level during stylus drag.
    if (isOld3DS) {
        document.addEventListener('mousemove', onCanvasMouseMove, true);
        document.addEventListener('mouseup', onCanvasMouseUp, true);
    } else {
        canvas.addEventListener('mousemove', onCanvasMouseMove, true);
    }
}

// --- TOUCH SUPPORT FOR MOBILE ---
// Add touch event handlers for mobile devices (wrapped so legacy console browsers like Wii/DSi Opera don't throw)
function getTouchPos(e) {
    if (!e.touches || e.touches.length === 0) return null;
    var touch = e.touches[0];
    var scroll = getScrollOffset();
    var pageX = touch.pageX !== undefined ? touch.pageX : touch.clientX + scroll.x;
    var pageY = touch.pageY !== undefined ? touch.pageY : touch.clientY + scroll.y;
    var cp = getCanvasPagePos();
    return {
        x: (pageX - cp.left) * (canvas.width / canvasDisplayW),
        y: (pageY - cp.top) * (canvas.height / canvasDisplayH)
    };
}

if (!isWii && !isDSi) {
    try {
        if ('ontouchstart' in window && canvas.addEventListener) {
            canvas.addEventListener(
                'touchstart',
                function (e) {
                    // Prevent scrolling and default browser touch actions on the canvas
                    if (e.cancelable !== false && e.preventDefault) e.preventDefault();

                    var pos = getTouchPos(e);
                    if (!pos) return;

                    // Reset coordinate tracking
                    lastX = pos.x;
                    lastY = pos.y;
                    lastDrawnX = pos.x;
                    lastDrawnY = pos.y;
                    pointQueue = [];

                    if (currTool === 'fill') {
                        saveHistory();
                        floodFill(pos.x, pos.y);
                        return;
                    }

                    saveHistory();
                    isDrawing = true;

                    ctx.beginPath();
                    ctx.arc(lastX, lastY, currSize / 2, 0, Math.PI * 2, false);
                    ctx.fillStyle = currTool === 'eraser' ? '#ffffff' : currColor;
                    ctx.strokeStyle = currTool === 'eraser' ? '#ffffff' : currColor;
                    ctx.fill();
                    ctx.beginPath();
                },
                false
            );

            canvas.addEventListener(
                'touchmove',
                function (e) {
                    if (!isDrawing) return;
                    if (e.cancelable !== false && e.preventDefault) e.preventDefault();

                    var pos = getTouchPos(e);
                    if (!pos) return;

                    // Draw immediately, exactly like onCanvasMouseMove does for
                    // everything except the DSi. This path previously always went
                    // through pointQueue, which meant stylus/finger input waited on
                    // the 30ms flush timer — and that timer gets clamped under
                    // drawing load, producing the "responds every half second" lag
                    // the mouse path was already fixed to avoid. Batching also
                    // couldn't help the one device it was meant for: these touch
                    // handlers only bind when (!isWii && !isDSi), so the DSi never
                    // reaches them.
                    ctx.beginPath();
                    ctx.moveTo(lastX, lastY);
                    ctx.lineTo(pos.x, pos.y);
                    ctx.stroke();
                    lastX = pos.x;
                    lastY = pos.y;
                },
                false
            );

            canvas.addEventListener(
                'touchend',
                function (e) {
                    if (e.preventDefault) e.preventDefault();
                    flushDrawQueue();
                    isDrawing = false;
                },
                false
            );

            canvas.addEventListener(
                'touchcancel',
                function (e) {
                    if (e.preventDefault) e.preventDefault();
                    flushDrawQueue();
                    isDrawing = false;
                },
                false
            );
        }
    } catch (ex) {}
}

// --- UI FUNCTIONS ---
function setColor(col, id) {
    currColor = col;
    if (currTool === 'eraser') {
        setTool('draw'); // Switch back to draw mode when a color is picked
    }
    ctx.strokeStyle = currColor;
    ctx.fillStyle = currColor;

    // Reset borders
    for (var i = 1; i <= 16; i++) {
        var el = document.getElementById('c' + i);
        if (el) {
            el.style.border = '2px solid #555555';
            el.style.borderColor = '#555555';
        }
    }
    var target = document.getElementById(id);
    if (target) {
        target.style.border = '2px solid #ffffff';
        target.style.borderColor = '#ffffff';
    }
}

function setTool(tool) {
    currTool = tool;
    var drawBtn = document.getElementById('btn-draw');
    var fillBtn = document.getElementById('btn-fill');
    var eraserBtn = document.getElementById('btn-eraser');

    if (drawBtn) {
        drawBtn.style.outline = currTool === 'draw' ? '2px solid white' : '';
        drawBtn.style.border = currTool === 'draw' ? '2px solid #ffffff' : '';
        drawBtn.style.borderColor = currTool === 'draw' ? '#ffffff' : '';
        drawBtn.style.background = currTool === 'draw' ? '#5865f2' : '';
        drawBtn.style.color = currTool === 'draw' ? '#ffffff' : '';
    }
    if (fillBtn) {
        fillBtn.style.outline = currTool === 'fill' ? '2px solid white' : '';
        fillBtn.style.border = currTool === 'fill' ? '2px solid #ffffff' : '';
        fillBtn.style.borderColor = currTool === 'fill' ? '#ffffff' : '';
        fillBtn.style.background = currTool === 'fill' ? '#5865f2' : '';
        fillBtn.style.color = currTool === 'fill' ? '#ffffff' : '';
    }
    if (eraserBtn) {
        eraserBtn.style.outline = currTool === 'eraser' ? '2px solid white' : '';
        eraserBtn.style.border = currTool === 'eraser' ? '2px solid #ffffff' : '';
        eraserBtn.style.borderColor = currTool === 'eraser' ? '#ffffff' : '';
        eraserBtn.style.background = currTool === 'eraser' ? '#5865f2' : '';
        eraserBtn.style.color = currTool === 'eraser' ? '#ffffff' : '';
    }

    if (currTool === 'eraser') {
        ctx.strokeStyle = '#ffffff';
        ctx.fillStyle = '#ffffff';
    } else {
        ctx.strokeStyle = currColor;
        ctx.fillStyle = currColor;
    }
}

function floodFill(startX, startY) {
    startX = Math.round(startX);
    startY = Math.round(startY);
    if (startX < 0 || startX >= canvas.width || startY < 0 || startY >= canvas.height) return;

    var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var data = imageData.data;
    var w = canvas.width;
    var h = canvas.height;

    var fillR = parseInt(currColor.slice(1, 3), 16);
    var fillG = parseInt(currColor.slice(3, 5), 16);
    var fillB = parseInt(currColor.slice(5, 7), 16);

    var idx = (startY * w + startX) * 4;
    var targetR = data[idx];
    var targetG = data[idx + 1];
    var targetB = data[idx + 2];
    var targetA = data[idx + 3];

    if (targetR === fillR && targetG === fillG && targetB === fillB && targetA === 255) return;

    // Extremely aggressive tolerance to swallow anti-aliasing halos.
    // 130000 / 195075 (max) is ~66% of the color space.
    // This ensures that even dark-gray pixels on a white-to-black gradient
    // are filled, leaving only the very core of the black line.
    var tolSq = 130000;
    var visited = [];
    var stack = [startX + startY * w];
    while (stack.length > 0) {
        var pos = stack.pop();
        if (visited[pos]) continue;
        visited[pos] = 1;
        var x = pos % w;
        var y = (pos - x) / w;
        var i = pos * 4;
        var dr = data[i] - targetR;
        var dg = data[i + 1] - targetG;
        var db = data[i + 2] - targetB;
        var da = data[i + 3] - targetA;
        if (dr * dr + dg * dg + db * db + da * da > tolSq) continue;
        data[i] = fillR;
        data[i + 1] = fillG;
        data[i + 2] = fillB;
        data[i + 3] = 255;
        if (x > 0) stack.push(pos - 1);
        if (x < w - 1) stack.push(pos + 1);
        if (y > 0) stack.push(pos - w);
        if (y < h - 1) stack.push(pos + w);
    }
    ctx.putImageData(imageData, 0, 0);
}

function setSize(s, id) {
    currSize = s;
    ctx.lineWidth = currSize;

    for (var i = 1; i <= 4; i++) {
        var el = document.getElementById('s' + i);
        if (el) {
            el.style.border = '2px solid #000000';
            el.style.borderColor = '#000000';
            el.style.background = '#b9bbbe';
        }
    }
    var target = document.getElementById(id);
    if (target) {
        target.style.border = '2px solid blue';
        target.style.borderColor = 'blue';
        target.style.background = '#00b0f4';
    }
}

function wipe() {
    saveHistory();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = currTool === 'eraser' ? '#ffffff' : currColor;
    isDrawing = false;
}

// --- SEND LOGIC ---
// Called from the form's onsubmit: fill in the drawing data and return true so
// the browser's own submit proceeds (calling form.submit() from inside onsubmit
// double-submits on some legacy browsers).
function prepareDrawing() {
    var inputField = document.getElementById('drawinginput');
    try {
        inputField.value = canvas.toDataURL('image/png');
    } catch (ex) {
        alert('Could not export the drawing on this browser.');
        return false;
    }
    return true;
}

function prepareAndSend() {
    if (prepareDrawing()) {
        document.getElementById('sendform').submit();
    }
}

function handleMessageKeydown(event) {
    var keyCode = event.keyCode || event.which;
    if (keyCode === 13 && !event.shiftKey) {
        event.preventDefault();
        prepareAndSend(); // prepareAndSend() already calls form.submit()
        return false;
    }
}

function autoResize(el) {
    if (!el) return;

    var currentLen = el.value.length;
    var lastLen = parseInt(el.getAttribute('data-last-len') || '0');
    el.setAttribute('data-last-len', currentLen);

    if (currentLen > lastLen) {
        if (el.scrollHeight > el.offsetHeight && el.offsetHeight < 200) {
            var newHeight = Math.min(el.scrollHeight, 200);
            el.style.height = newHeight + 'px';
        }
    } else {
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

// Initialize UI
setColor('#000000', 'c1');
setSize(5, 's2');
setTool('draw');
