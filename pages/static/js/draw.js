var canvas = document.getElementById('sketchpad');
var ctx = canvas.getContext('2d');

// Detect old Nintendo 3DS (hardware model released 2011, not "New Nintendo 3DS").
// Old 3DS has a slow CPU and only 64MB RAM vs New 3DS's 256MB. On old 3DS:
//   1. canvas.toDataURL() on a 600×350 (210,000-pixel) canvas may produce a
//      corrupt or truncated PNG due to memory pressure — Discord then shows
//      "cannot load this image".
//   2. e.offsetX/offsetY in NintendoBrowser 1.x may return page-relative
//      coordinates instead of element-relative ones, causing drawing to be
//      misaligned ("cannot draw straight lines").
var ua = (navigator.userAgent || '');
var isOld3DS = ua.indexOf('Nintendo 3DS') >= 0 && ua.indexOf('New Nintendo 3DS') < 0;

// Add class to <html> element so CSS can target old 3DS without media queries
// (old NintendoBrowser may not parse all media queries correctly).
if (isOld3DS) {
    document.documentElement.className += ' old-3ds';
}

// On very small screens (DSi: 256px wide), shrink the canvas backing buffer
// before any drawing. The internal canvas is 600×350 = 210,000 pixels; even
// a single ctx.stroke() forces Opera 9.5 to repaint all of them which is
// very slow. 240×140 has the same 12:7 aspect ratio but only ~33,600 pixels
// — roughly 6× fewer pixels per repaint, which brings drawing to a usable fps.
// This must happen BEFORE ctx operations (resizing canvas resets its content).
if (screen.width && screen.width <= 256) {
    canvas.width = 240;
    canvas.height = 140;
} else if (isOld3DS) {
    // 300×175 keeps the same 12:7 aspect ratio as 600×350 but uses only
    // ~52,500 pixels (1/4 as many), keeping toDataURL() within old 3DS
    // memory limits and making stroke repaints fast enough to draw with.
    canvas.width = 300;
    canvas.height = 175;
}

var isDrawing = false;
var lastX = 0;
var lastY = 0;
var currColor = '#000000';
var currSize = 5;
var currTool = 'draw';

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
ctx.fillStyle = "#ffffff";
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
    var left = 0, top = 0;
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
    // Skip on old Nintendo 3DS (NintendoBrowser 1.x) where offsetX/offsetY
    // may be page-relative instead of element-relative, causing misaligned
    // drawing coordinates ("cannot draw straight lines").
    if (e.offsetX !== undefined && !isOld3DS) {
        return {
            x: e.offsetX * (canvas.width / canvasDisplayW),
            y: e.offsetY * (canvas.height / canvasDisplayH)
        };
    }
    // Fallback: pageX/pageY + canvas page offset
    var scroll = getScrollOffset();
    var pageX = e.pageX !== undefined ? e.pageX : (e.clientX + scroll.x);
    var pageY = e.pageY !== undefined ? e.pageY : (e.clientY + scroll.y);
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
// Flush at ~30ms intervals (~33fps). DSi Opera 9.5 does not support
// requestAnimationFrame, so setInterval is used instead.
setInterval(flushDrawQueue, 30);

// --- DRAWING EVENTS ---
canvas.onmousedown = function(e) {
    if(e.preventDefault) e.preventDefault(); // Stop Wii Drag
    var pos = getPos(e);
    if (currTool === 'fill') {
        floodFill(pos.x, pos.y);
        return false;
    }
    isDrawing = true;
    lastX = pos.x;
    lastY = pos.y;
    lastDrawnX = pos.x;
    lastDrawnY = pos.y;
    pointQueue = [];
    
    ctx.beginPath();
    ctx.arc(lastX, lastY, currSize/2, 0, Math.PI*2, false);
    ctx.fillStyle = currColor;
    ctx.fill();
    ctx.beginPath();
    
    return false;
};

canvas.onmousemove = function(e) {
    if (!isDrawing) return;
    if(e.preventDefault) e.preventDefault(); 

    var pos = getPos(e);
    pointQueue.push({ x: pos.x, y: pos.y });
    lastX = pos.x;
    lastY = pos.y;
};

canvas.onmouseup = function() { flushDrawQueue(); isDrawing = false; };
canvas.onmouseout = function() { flushDrawQueue(); isDrawing = false; };

// --- OLD 3DS: CLICK-TO-DRAW MODE ---
// NintendoBrowser 1.x cursor model: holding the stylus shows a cursor;
// moving it fires mousemove events while hovering (button NOT held).
// A tap fires mousedown → mouseup → click — mousemove does NOT fire while the
// button is held. This means the standard press-hold-drag model never works
// (mouseup fires before any mousemove, so isDrawing is false when cursor moves).
//
// Two additional quirks on old 3DS:
//   1. cursor mousemove events may fire on document rather than on the canvas
//      element, so canvas.onmousemove misses them.
//   2. setInterval(fn, 30) may be unreliable on NintendoBrowser 1.x, so the
//      canvas.onmousemove queue would never be flushed to the screen.
//
// Fix:
//   - canvas.onclick toggles isDrawing on/off (first tap starts, second ends)
//   - document.onmousemove draws each segment immediately (no queue needed)
//   - canvas.onmousedown/onmouseup/onmouseout are disabled so they don't
//     interfere with the click-toggle state
if (isOld3DS) {
    canvas.onmousedown = function(e) { if (e.preventDefault) e.preventDefault(); return false; };
    canvas.onmouseup   = null;
    canvas.onmouseout  = null;
    canvas.onmousemove = null; // document-level handler used instead

    // Cached canvas bounding rect for coordinate calculation.
    // getBoundingClientRect() is called once per drawing session (at draw start)
    // so we don't force a layout reflow on every mousemove event.
    var old3dsRect = null;

    // Compute canvas-relative coordinates using clientX/clientY and
    // getBoundingClientRect() — more reliable on NintendoBrowser 1.x WebKit
    // than the offsetLeft/offsetTop traversal in getPos(), which may give
    // wrong results depending on the browser's offsetParent implementation.
    // Falls back to getPos() if getBoundingClientRect is not available.
    function getOld3DSPos(e) {
        var rect = old3dsRect;
        if (rect && rect.width > 0) {
            // clientX/clientY are viewport-relative, matching getBoundingClientRect().
            // If clientX is not available, convert pageX to viewport-relative by
            // subtracting the page scroll offset.
            var sx = window.pageXOffset !== undefined ? window.pageXOffset
                   : (document.documentElement ? document.documentElement.scrollLeft : 0) || 0;
            var sy = window.pageYOffset !== undefined ? window.pageYOffset
                   : (document.documentElement ? document.documentElement.scrollTop : 0) || 0;
            var cx = e.clientX !== undefined ? e.clientX
                   : (e.pageX !== undefined ? e.pageX - sx : null);
            var cy = e.clientY !== undefined ? e.clientY
                   : (e.pageY !== undefined ? e.pageY - sy : null);
            if (cx !== null && cy !== null) {
                return {
                    x: (cx - rect.left) * (canvas.width / rect.width),
                    y: (cy - rect.top) * (canvas.height / rect.height)
                };
            }
        }
        return getPos(e);
    }

    canvas.onclick = function(e) {
        if (e.preventDefault) e.preventDefault();
        // Refresh cached canvas rect on every tap so layout changes (scroll,
        // resize) are reflected.
        old3dsRect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
        var pos = getOld3DSPos(e);
        if (currTool === 'fill') {
            floodFill(pos.x, pos.y);
            return false;
        }
        if (!isDrawing) {
            isDrawing = true;
            lastX = pos.x;
            lastY = pos.y;
            lastDrawnX = pos.x;
            lastDrawnY = pos.y;
            pointQueue = [];
            // Draw a dot so single taps are visible.
            ctx.beginPath();
            ctx.arc(lastX, lastY, currSize / 2, 0, Math.PI * 2, false);
            ctx.fillStyle = currColor;
            ctx.fill();
            ctx.beginPath();
        } else {
            isDrawing = false;
        }
        return false;
    };

    // Capture cursor movement anywhere on the page (not just over the canvas).
    // Draw each segment immediately — no queue, no setInterval dependency.
    document.onmousemove = function(e) {
        if (!isDrawing) return;
        var pos = getOld3DSPos(e);
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(pos.x, pos.y);
        ctx.stroke();
        lastX = pos.x;
        lastY = pos.y;
        lastDrawnX = pos.x;
        lastDrawnY = pos.y;
    };
}

// --- TOUCH SUPPORT FOR MOBILE ---
// Add touch event handlers for mobile devices (alongside mouse handlers for Wii compatibility)
function getTouchPos(e) {
    if (!e.touches || e.touches.length === 0) return null;
    var touch = e.touches[0];
    var scroll = getScrollOffset();
    var pageX = touch.pageX !== undefined ? touch.pageX : (touch.clientX + scroll.x);
    var pageY = touch.pageY !== undefined ? touch.pageY : (touch.clientY + scroll.y);
    var cp = getCanvasPagePos();
    return {
        x: (pageX - cp.left) * (canvas.width / canvasDisplayW),
        y: (pageY - cp.top) * (canvas.height / canvasDisplayH)
    };
}

canvas.addEventListener('touchstart', function(e) {
    if(e.preventDefault) e.preventDefault(); // Prevent scrolling
    var pos = getTouchPos(e);
    if (!pos) return;
    if (currTool === 'fill') {
        floodFill(pos.x, pos.y);
        return;
    }
    isDrawing = true;
    lastX = pos.x;
    lastY = pos.y;
    lastDrawnX = pos.x;
    lastDrawnY = pos.y;
    pointQueue = [];
    
    ctx.beginPath();
    ctx.arc(lastX, lastY, currSize/2, 0, Math.PI*2, false);
    ctx.fillStyle = currColor;
    ctx.fill();
    ctx.beginPath();
}, false);

canvas.addEventListener('touchmove', function(e) {
    if (!isDrawing) return;
    if(e.preventDefault) e.preventDefault(); // Prevent scrolling
    
    var pos = getTouchPos(e);
    if (!pos) return;
    pointQueue.push({ x: pos.x, y: pos.y });
    lastX = pos.x;
    lastY = pos.y;
}, false);

canvas.addEventListener('touchend', function(e) {
    if(e.preventDefault) e.preventDefault();
    flushDrawQueue();
    isDrawing = false;
}, false);

canvas.addEventListener('touchcancel', function(e) {
    if(e.preventDefault) e.preventDefault();
    flushDrawQueue();
    isDrawing = false;
}, false);

// --- UI FUNCTIONS ---
function setColor(col, id) {
    currColor = col;
    ctx.strokeStyle = currColor;
    
    // Reset borders
    for(var i=1; i<=16; i++) {
        var el = document.getElementById('c'+i);
        if(el) el.style.border = "2px solid #555";
    }
    document.getElementById(id).style.border = "2px solid white";
}

function setTool(tool) {
    currTool = (currTool === tool) ? 'draw' : tool;
    var fillBtn = document.getElementById('btn-fill');
    if (fillBtn) {
        fillBtn.style.outline = (currTool === 'fill') ? '2px solid white' : '';
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

    // Tolerance of 32 (squared: 1024) catches anti-aliased edge pixels that are
    // blended near-target colors, preventing the stray-pixel halo left by exact fill.
    var tolSq = 32 * 32;
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
        if (dr*dr + dg*dg + db*db + da*da > tolSq) continue;
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

    for(var i=1; i<=4; i++) {
        var el = document.getElementById('s'+i);
        if(el) el.style.border = "2px solid #000";
    }
    document.getElementById(id).style.border = "2px solid blue";
}

function wipe() {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = currColor;
}

// --- SEND LOGIC ---
function prepareAndSend() {
    var inputField = document.getElementById('drawinginput');
    var form = document.getElementById('sendform');
    var data;
    if (isOld3DS) {
        // Old NintendoBrowser (1.x) does not support PNG encoding in toDataURL —
        // the spec says unsupported formats return "data:,". JPEG is more widely
        // supported in old WebKit and produces smaller output (less memory pressure).
        data = canvas.toDataURL("image/jpeg", 0.7);
        // If JPEG also fails, try PNG as a last resort
        if (data === 'data:,') {
            data = canvas.toDataURL("image/png");
        }
    } else {
        data = canvas.toDataURL("image/png");
    }
    inputField.value = data;
    form.submit();
}

// Initialize UI
setColor('#000000', 'c1');
setSize(5, 's2');
