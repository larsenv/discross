/* 3DSPaint / Discross Old 3DS Optimized Drawing Engine */
var layer = 2,
    color = [0, 0, 0],
    saving = false,
    painting = false,
    dropping = false,
    erasing = false,
    block = 6,
    canvas = [],
    context = [],
    colordiv = null,
    statusdiv = null,
    toggle = 0,
    mouseX = 0,
    mouseY = 0,
    points = [];

var _ua = navigator.userAgent.toLowerCase();
var isOld3DS = _ua.indexOf('nintendo 3ds') !== -1 && _ua.indexOf('nintendobrowser') === -1;
var isWii =
    (_ua.indexOf('nintendo wii') !== -1 || _ua.indexOf('wii') !== -1) && _ua.indexOf('wiiu') === -1;
var isDSi = _ua.indexOf('nintendo dsi') !== -1 || _ua.indexOf('dsi') !== -1;

function init() {
    for (var i = 0; i <= 4; i++) {
        canvas[i] = document.getElementById('canvas' + i);
    }
    for (var i = 5; --i >= 0; ) {
        if (canvas[i]) {
            context[i] = canvas[i].getContext('2d');
            context[i].lineCap = 'round';
            context[i].lineJoin = 'round';
            context[i].lineWidth = 1;
            canvas[i].style.borderColor = '#' + (toggle ^= 1) + toggle + toggle;
        }
    }

    var topCanvas = canvas[4];
    if (topCanvas) {
        if (isWii || isDSi) {
            topCanvas.onmousedown = function (e) {
                e = e || window.event;
                if (e && e.preventDefault) e.preventDefault();
                mousedown(e);
                return false;
            };
            topCanvas.onmousemove = function (e) {
                e = e || window.event;
                if (e && e.preventDefault) e.preventDefault();
                mousemove(e);
                return false;
            };
            topCanvas.onmouseup = function (e) {
                e = e || window.event;
                mouseup(e);
                return false;
            };
            topCanvas.onmouseout = function (e) {
                e = e || window.event;
                mouseup(e);
                return false;
            };
            topCanvas.onclick = function (e) {
                e = e || window.event;
                click(e);
                return false;
            };
        } else if (isOld3DS) {
            // Old 3DS ("SPIDER" NetFront): the stylus press fires mousedown on the canvas,
            // but the subsequent mousemove/mouseup fire at the DOCUMENT level, not on the
            // canvas (same quirk handled in draw.js). Binding move/up on the canvas — as we
            // do for New 3DS/desktop — paints only the initial dot and never tracks the
            // stroke. Bind mousemove/mouseup on document so drawing actually works.
            topCanvas.addEventListener('mousedown', mousedown, true);
            topCanvas.addEventListener('touchstart', touchdown, true);
            topCanvas.addEventListener('touchmove', touchmove, true);
            topCanvas.addEventListener('touchend', mouseup, true);
            topCanvas.addEventListener('click', click, true);
            document.addEventListener('mousemove', mousemove, true);
            document.addEventListener('mouseup', mouseup, true);
        } else {
            topCanvas.addEventListener('mousedown', mousedown, true);
            topCanvas.addEventListener('touchstart', touchdown, true);
            topCanvas.addEventListener('mousemove', mousemove, true);
            topCanvas.addEventListener('touchmove', touchmove, true);
            topCanvas.addEventListener('mouseup', mouseup, true);
            topCanvas.addEventListener('touchend', mouseup, true);
            topCanvas.addEventListener('mouseout', mouseup, true);
            topCanvas.addEventListener('click', click, true);
        }
    }

    colordiv = document.getElementById('b_color');
    statusdiv = document.getElementById('status');
    if (statusdiv) {
        statusdiv.innerHTML = '3DS Drawing Mode Ready';
    }

    setColor('#000000', 'c1');
    set_layer(2);
    set_brush(6);
}

if (document.getElementById('canvas0')) {
    init();
} else {
    window.onload = init;
}

function setColor(hex, id) {
    if (hex && hex.charAt(0) === '#') hex = hex.slice(1);
    var r = parseInt(hex.slice(0, 2), 16) || 0;
    var g = parseInt(hex.slice(2, 4), 16) || 0;
    var b = parseInt(hex.slice(4, 6), 16) || 0;
    color = [r, g, b];
    erasing = false;
    var ersBtn = document.getElementById('b_erase');
    if (ersBtn) ersBtn.style.background = '#b9bbbe';

    for (var i = 1; i <= 16; i++) {
        var el = document.getElementById('c' + i);
        if (el) el.style.border = '1px solid #202225';
    }
    var target = document.getElementById(id);
    if (target) target.style.border = '2px solid #ffffff';

    if (statusdiv) {
        statusdiv.innerHTML = 'Color set to (' + color.join(',') + ')';
        statusdiv.style.display = 'block';
    }
    if (colordiv) {
        colordiv.style.background = 'rgb(' + color.join(',') + ')';
    }
    return false;
}

function getEventX(e) {
    if (e.targetTouches && e.targetTouches.length > 0) {
        return isOld3DS && e.targetTouches[0].screenX !== undefined
            ? e.targetTouches[0].screenX
            : e.targetTouches[0].clientX;
    }
    return e.clientX !== undefined ? e.clientX : e.pageX || 0;
}

function getEventY(e) {
    if (e.targetTouches && e.targetTouches.length > 0) {
        return isOld3DS && e.targetTouches[0].screenY !== undefined
            ? e.targetTouches[0].screenY
            : e.targetTouches[0].clientY;
    }
    return e.clientY !== undefined ? e.clientY : e.pageY || 0;
}

function touchmove(e) {
    if (e.touches && e.touches.length === 1) {
        if (e.cancelable !== false && e.preventDefault) e.preventDefault();
        mousemove(e);
    }
}

function touchdown(e) {
    if (e.touches && e.touches.length === 1) {
        if (e.cancelable !== false && e.preventDefault) e.preventDefault();
        mousedown(e);
    }
}

function mousedown(e) {
    e = e || window.event;
    var rect = canvas[4].getBoundingClientRect
        ? canvas[4].getBoundingClientRect()
        : { left: 0, top: 0 };
    var cx = getEventX(e);
    var cy = getEventY(e);
    mouseX = cx - rect.left - (block >> 2);
    mouseY = cy - rect.top - (block >> 2);
    painting = true;
    if (statusdiv) statusdiv.style.display = 'none';

    if (!dropping && context[layer]) {
        if (erasing) {
            context[layer].globalCompositeOperation = 'destination-out';
            context[layer].fillStyle = '#000000';
        } else {
            context[layer].globalCompositeOperation = 'source-over';
            context[layer].fillStyle = 'rgb(' + color.join(',') + ')';
        }
        context[layer].beginPath();
        context[layer].arc(
            mouseX + (block >> 2),
            mouseY + (block >> 2),
            block / 2,
            0,
            Math.PI * 2,
            false
        );
        context[layer].fill();
    }
}

function mouseup(e) {
    painting = false;
    points[points.length] = [0, 0, 0, 0, 0, 0, -1];
}

function click(e) {
    e = e || window.event;
    if (dropping) {
        var rect = canvas[4].getBoundingClientRect
            ? canvas[4].getBoundingClientRect()
            : { left: 0, top: 0 };
        var cx = getEventX(e);
        var cy = getEventY(e);
        var x = Math.round(cx - rect.left);
        var y = Math.round(cy - rect.top);
        if (x >= 0 && x < 240 && y >= 0 && y < 200 && context[layer]) {
            var data = context[layer].getImageData(x, y, 1, 1).data;
            color = [data[0], data[1], data[2]];
            if (colordiv) colordiv.style.background = 'rgb(' + color.join(',') + ')';
            if (statusdiv) {
                statusdiv.innerHTML = 'Color set to (' + color.join(',') + ')';
                statusdiv.style.display = 'block';
            }
            if (canvas[layer])
                canvas[layer].style.borderColor = '#' + (toggle ^= 1) + toggle + toggle;
            var dropBtn = document.getElementById('i_dropper');
            if (dropBtn) dropBtn.style.background = '#b9bbbe';
            dropping = false;
            erasing = false;
            var ersBtn = document.getElementById('b_erase');
            if (ersBtn) ersBtn.style.background = '#b9bbbe';

            for (var i = 1; i <= 16; i++) {
                var el = document.getElementById('c' + i);
                if (el) el.style.border = '1px solid #202225';
            }
        }
    }
}

function mousemove(e) {
    if (painting && !dropping) {
        e = e || window.event;
        var rect = canvas[4].getBoundingClientRect
            ? canvas[4].getBoundingClientRect()
            : { left: 0, top: 0 };
        var cx = getEventX(e);
        var cy = getEventY(e);
        var newX = cx - rect.left - (block >> 2);
        var newY = cy - rect.top - (block >> 2);
        if (context[layer]) {
            if (erasing) {
                context[layer].globalCompositeOperation = 'destination-out';
                context[layer].strokeStyle = '#000000';
            } else {
                context[layer].globalCompositeOperation = 'source-over';
                context[layer].strokeStyle = 'rgb(' + color.join(',') + ')';
            }
            context[layer].lineWidth = block;
            context[layer].beginPath();
            context[layer].moveTo(mouseX, mouseY);
            context[layer].lineTo((mouseX = newX), (mouseY = newY));
            context[layer].stroke();
            if (canvas[layer])
                canvas[layer].style.borderColor = '#' + (toggle ^= 1) + toggle + toggle;
            points[points.length] = [color[0], color[1], color[2], block, mouseX, mouseY, layer];
        }
    }
}

function set_layer(num) {
    layer = num;
    var layers = document.getElementsByClassName('layer-btn');
    for (var i = layers.length; --i >= 0; ) {
        layers[i].style.background = '#b9bbbe';
    }
    var activeLayerBtn = document.getElementById('btn_layer_' + num);
    if (activeLayerBtn) activeLayerBtn.style.background = '#00b0f4';

    if (statusdiv) {
        statusdiv.innerHTML = 'Layer set to ' + num;
        statusdiv.style.display = 'block';
    }
    return false;
}

function set_brush(num) {
    block = num;
    var brushes = document.getElementsByClassName('brush-btn');
    for (var i = brushes.length; --i >= 0; ) {
        brushes[i].style.background = '#b9bbbe';
    }
    var activeBrushBtn = document.getElementById('btn_brush_' + num);
    if (activeBrushBtn) activeBrushBtn.style.background = '#00b0f4';

    if (statusdiv) {
        statusdiv.innerHTML = 'Brush set to ' + num + 'px';
        statusdiv.style.display = 'block';
    }
    return false;
}

function set_dropper() {
    dropping = !dropping;
    var dropBtn = document.getElementById('i_dropper');
    if (dropBtn) dropBtn.style.background = dropping ? '#00b0f4' : '#b9bbbe';
    if (statusdiv) {
        statusdiv.innerHTML = dropping ? 'Dropper active (click canvas)' : 'Dropper deactivated';
        statusdiv.style.display = 'block';
    }
    return false;
}

function toggle_erase() {
    erasing = !erasing;
    dropping = false;
    var dropBtn = document.getElementById('i_dropper');
    if (dropBtn) dropBtn.style.background = '#b9bbbe';
    var ersBtn = document.getElementById('b_erase');
    if (ersBtn) ersBtn.style.background = erasing ? '#00b0f4' : '#b9bbbe';
    if (statusdiv) {
        statusdiv.innerHTML = erasing ? 'Eraser active' : 'Drawing active';
        statusdiv.style.display = 'block';
    }
    return false;
}

function clear_layer() {
    if (context[layer] && canvas[layer]) {
        context[layer].clearRect(0, 0, canvas[layer].width, canvas[layer].height);
        if (statusdiv) {
            statusdiv.innerHTML = 'Layer ' + layer + ' cleared';
            statusdiv.style.display = 'block';
        }
    }
    return false;
}

function save() {
    if (!saving) {
        saving = true;
        var saveBtn = document.getElementById('b_save');
        if (saveBtn) saveBtn.style.background = '#4752c4';
        if (statusdiv) {
            statusdiv.innerHTML = 'Combining layers and sending...';
            statusdiv.style.display = 'block';
        }

        try {
            var tempCanvas = document.createElement('canvas');
            tempCanvas.width = 240;
            tempCanvas.height = 200;
            var tempCtx = tempCanvas.getContext('2d');
            tempCtx.fillStyle = '#ffffff';
            tempCtx.fillRect(0, 0, 240, 200);

            for (var i = 0; i <= 4; i++) {
                if (canvas[i]) {
                    tempCtx.drawImage(canvas[i], 0, 0);
                }
            }

            var data = tempCanvas.toDataURL('image/png');
            var inputField = document.getElementById('drawinginput');
            var form = document.getElementById('sendform');
            if (inputField && form) {
                inputField.value = data;
                form.submit();
            } else {
                saving = false;
                if (saveBtn) saveBtn.style.background = '#5865f2';
                if (statusdiv) statusdiv.innerHTML = 'Error: form not found';
            }
        } catch (err) {
            saving = false;
            if (saveBtn) saveBtn.style.background = '#5865f2';
            if (statusdiv) statusdiv.innerHTML = 'Error: ' + (err.message || err);
        }
    }
    return false;
}
