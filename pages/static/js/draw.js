var canvas = document.getElementById('sketchpad');
var ctx = canvas.getContext('2d');

// On very small screens (DSi: 256px wide), shrink the canvas backing buffer
// before any drawing. The internal canvas is 600×350 = 210,000 pixels; even
// a single ctx.stroke() forces Opera 9.5 to repaint all of them which is
// very slow. 240×140 has the same 12:7 aspect ratio but only ~33,600 pixels
// — roughly 6× fewer pixels per repaint, which brings drawing to a usable fps.
// This must happen BEFORE ctx operations (resizing canvas resets its content).
if (screen.width && screen.width <= 256) {
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
    if (historyStack.length >= maxHistory) {
        historyStack.shift();
    }
    historyStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
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
    var wrapper = document.getElementById('canvas-wrapper');
    // Subtract 10px to account for the 5px padding on each side of #canvas-wrapper
    var maxW = wrapper.offsetWidth - 10;
    if (maxW > 0 && maxW < canvas.width) {
        var ratio = maxW / canvas.width;
        canvasDisplayW = maxW;
        canvasDisplayH = Math.round(canvas.height * ratio);
        canvas.style.width = canvasDisplayW + 'px';
        canvas.style.height = canvasDisplayH + 'px';
    } else if (maxW > 0) {
        canvasDisplayW = canvas.width;
        canvasDisplayH = canvas.height;
        canvas.style.width = '';
        canvas.style.height = '';
    }
    // If maxW <= 0 layout isn't ready yet; values stay at previous setting
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
    // e.offsetX/offsetY: element-relative CSS pixels. Available in Opera 9+.
    // Works correctly regardless of page scroll or element position.
    if (e.offsetX !== undefined) {
        return {
            x: e.offsetX * (canvas.width / canvasDisplayW),
            y: e.offsetY * (canvas.height / canvasDisplayH),
        };
    }
    // Fallback: pageX/pageY + canvas page offset
    var scroll = getScrollOffset();
    var pageX = e.pageX !== undefined ? e.pageX : e.clientX + scroll.x;
    var pageY = e.pageY !== undefined ? e.pageY : e.clientY + scroll.y;
    var cp = getCanvasPagePos();
    return {
        x: (pageX - cp.left) * (canvas.width / canvasDisplayW),
        y: (pageY - cp.top) * (canvas.height / canvasDisplayH),
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
// Flush at ~30ms intervals (~33fps). DSi Opera 9.5 does not support
// requestAnimationFrame, so setInterval is used instead.
setInterval(flushDrawQueue, 30);

// --- DRAWING EVENTS ---
canvas.onmousedown = function (e) {
    if (e.preventDefault) e.preventDefault(); // Stop Wii Drag
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

    ctx.beginPath();
    ctx.arc(lastX, lastY, currSize / 2, 0, Math.PI * 2, false);
    ctx.fillStyle = currTool === 'eraser' ? '#ffffff' : currColor;
    ctx.strokeStyle = currTool === 'eraser' ? '#ffffff' : currColor;
    ctx.fill();
    ctx.beginPath();

    return false;
};

canvas.onmousemove = function (e) {
    if (!isDrawing) return;
    if (e.preventDefault) e.preventDefault();

    var pos = getPos(e);
    pointQueue.push({ x: pos.x, y: pos.y });
    lastX = pos.x;
    lastY = pos.y;
};

canvas.onmouseup = function () {
    flushDrawQueue();
    isDrawing = false;
};
canvas.onmouseout = function () {
    flushDrawQueue();
    isDrawing = false;
};

// --- TOUCH SUPPORT FOR MOBILE ---
// Add touch event handlers for mobile devices (alongside mouse handlers for Wii compatibility)
function getTouchPos(e) {
    if (!e.touches || e.touches.length === 0) return null;
    var touch = e.touches[0];
    var scroll = getScrollOffset();
    var pageX = touch.pageX !== undefined ? touch.pageX : touch.clientX + scroll.x;
    var pageY = touch.pageY !== undefined ? touch.pageY : touch.clientY + scroll.y;
    var cp = getCanvasPagePos();
    return {
        x: (pageX - cp.left) * (canvas.width / canvasDisplayW),
        y: (pageY - cp.top) * (canvas.height / canvasDisplayH),
    };
}

canvas.addEventListener(
    'touchstart',
    function (e) {
        // Prevent scrolling and default browser touch actions on the canvas
        if (e.cancelable) e.preventDefault();

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
    { passive: false }
);

canvas.addEventListener(
    'touchmove',
    function (e) {
        if (!isDrawing) return;
        if (e.cancelable) e.preventDefault();

        var pos = getTouchPos(e);
        if (!pos) return;

        // Push segments to queue
        pointQueue.push({ x: pos.x, y: pos.y });
        lastX = pos.x;
        lastY = pos.y;
    },
    { passive: false }
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
        if (el) el.style.border = '2px solid #555';
    }
    var target = document.getElementById(id);
    if (target) target.style.border = '2px solid white';
}

function setTool(tool) {
    currTool = tool;
    var drawBtn = document.getElementById('btn-draw');
    if (drawBtn) {
        drawBtn.style.outline = currTool === 'draw' ? '2px solid white' : '';
    }
    var fillBtn = document.getElementById('btn-fill');
    if (fillBtn) {
        fillBtn.style.outline = currTool === 'fill' ? '2px solid white' : '';
    }
    var eraserBtn = document.getElementById('btn-eraser');
    if (eraserBtn) {
        eraserBtn.style.outline = currTool === 'eraser' ? '2px solid white' : '';
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
        if (el) el.style.border = '2px solid #000';
    }
    var target = document.getElementById(id);
    if (target) target.style.border = '2px solid blue';
}

function wipe() {
    saveHistory();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = currTool === 'eraser' ? '#ffffff' : currColor;
}

// --- SEND LOGIC ---
function prepareAndSend() {
    var inputField = document.getElementById('drawinginput');
    var form = document.getElementById('sendform');
    var data = canvas.toDataURL('image/png');
    inputField.value = data;
    form.submit();
}

// Initialize UI
setColor('#000000', 'c1');
setSize(5, 's2');
setTool('draw');
