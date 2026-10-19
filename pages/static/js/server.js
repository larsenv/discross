// IE8/Opera 9.x-compatible element sibling traversal helpers.
// nextElementSibling and previousElementSibling are IE9+ only.
function nextElemSibling(el) {
    var s = el.nextSibling;
    while (s && s.nodeType !== 1) {
        s = s.nextSibling;
    }
    return s;
}
function prevElemSibling(el) {
    var s = el.previousSibling;
    while (s && s.nodeType !== 1) {
        s = s.previousSibling;
    }
    return s;
}

// classList-compatible helpers for IE8/Opera 9.x which lack classList.
function hasClass(el, cls) {
    return (' ' + el.className + ' ').indexOf(' ' + cls + ' ') !== -1;
}
function addClass(el, cls) {
    if (!hasClass(el, cls)) {
        el.className = (el.className + ' ' + cls).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    }
}
function removeClass(el, cls) {
    var re = new RegExp('(^|\\s)' + cls + '(\\s|$)', 'g');
    el.className = el.className
        .replace(re, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^\s+|\s+$/g, '');
}
function toggleClass(el, cls) {
    if (hasClass(el, cls)) {
        removeClass(el, cls);
        return false;
    }
    addClass(el, cls);
    return true;
}

// Helper to find all elements by class for IE6/7 compatibility
function getElementsByClass(cls) {
    if (document.querySelectorAll) return document.querySelectorAll('.' + cls);
    if (document.getElementsByClassName) return document.getElementsByClassName(cls);

    var res = [];
    var all = document.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) {
        if (hasClass(all[i], cls)) res.push(all[i]);
    }
    return res;
}

// Category collapse/expand functionality (#17)
function toggleCategory(element) {
    var arrow = element.querySelector ? element.querySelector('.category-arrow') : null;
    if (!arrow) {
        var imgs = element.getElementsByTagName('img');
        for (var i = 0; i < imgs.length; i++) {
            if (hasClass(imgs[i], 'category-arrow')) {
                arrow = imgs[i];
                break;
            }
        }
    }

    // Find the category-channels div - it should be a sibling after potentially a BR
    var categoryDiv = null;
    var sibling = nextElemSibling(element);

    // Skip over BR tags to find the category-channels div
    while (sibling) {
        if (hasClass(sibling, 'category-channels')) {
            categoryDiv = sibling;
            break;
        }
        sibling = nextElemSibling(sibling);
    }

    if (categoryDiv) {
        var isCollapsed = toggleClass(categoryDiv, 'collapsed');
        if (arrow) {
            arrow.src = isCollapsed
                ? '/resources/twemoji/25b6.gif'
                : '/resources/twemoji/1f53d.gif';
            arrow.alt = isCollapsed ? '>' : 'v';
        }

        // Store state in localStorage
        try {
            var categoryId = categoryDiv.id;
            if (categoryId && typeof localStorage !== 'undefined') {
                localStorage.setItem(categoryId, isCollapsed ? 'collapsed' : 'expanded');
            }
        } catch (e) {
            // localStorage might not be available
        }
    }
}

// Thread group collapse/expand functionality
function toggleThreads(element) {
    var arrow = element.querySelector ? element.querySelector('.thread-arrow') : null;
    if (!arrow) {
        var imgs = element.getElementsByTagName('img');
        for (var i = 0; i < imgs.length; i++) {
            if (hasClass(imgs[i], 'thread-arrow')) {
                arrow = imgs[i];
                break;
            }
        }
    }

    var threadDiv = null;
    var sibling = nextElemSibling(element);

    while (sibling) {
        if (hasClass(sibling, 'thread-channels')) {
            threadDiv = sibling;
            break;
        }
        sibling = nextElemSibling(sibling);
    }

    if (threadDiv) {
        var isCollapsed = toggleClass(threadDiv, 'collapsed');
        if (arrow) {
            arrow.src = isCollapsed
                ? '/resources/twemoji/25b6.gif'
                : '/resources/twemoji/1f53d.gif';
            arrow.alt = isCollapsed ? '>' : 'v';
        }

        try {
            var id = threadDiv.id;
            if (id && typeof localStorage !== 'undefined') {
                localStorage.setItem(id, isCollapsed ? 'collapsed' : 'expanded');
            }
        } catch (e) {
            // localStorage might not be available
        }
    }
}

// Restore category and thread group states on page load
window.onload = function () {
    try {
        var categories = getElementsByClass('category-channels');
        for (var i = 0; i < categories.length; i++) {
            var cat = categories[i];
            var state = typeof localStorage !== 'undefined' ? localStorage.getItem(cat.id) : null;
            if (state === 'collapsed') {
                addClass(cat, 'collapsed');

                // Find the previous category link to update arrow
                var prevSibling = prevElemSibling(cat);
                while (prevSibling) {
                    if (prevSibling.tagName === 'A' && prevSibling.onclick) {
                        var arrow = null;
                        if (prevSibling.querySelector) {
                            arrow = prevSibling.querySelector('.category-arrow');
                        } else {
                            var imgs = prevSibling.getElementsByTagName('img');
                            for (var j = 0; j < imgs.length; j++) {
                                if (hasClass(imgs[j], 'category-arrow')) {
                                    arrow = imgs[j];
                                    break;
                                }
                            }
                        }

                        if (arrow) {
                            arrow.src = '/resources/twemoji/25b6.gif';
                            arrow.alt = '>';
                            break;
                        }
                    }
                    prevSibling = prevElemSibling(prevSibling);
                }
            }
        }

        var threadGroups = getElementsByClass('thread-channels');
        for (var tgIndex = 0; tgIndex < threadGroups.length; tgIndex++) {
            var tg = threadGroups[tgIndex];
            var tgState = typeof localStorage !== 'undefined' ? localStorage.getItem(tg.id) : null;
            if (tgState === 'collapsed') {
                addClass(tg, 'collapsed');

                var prevElement = prevElemSibling(tg);
                while (prevElement) {
                    if (prevElement.tagName === 'A' && prevElement.onclick) {
                        var tArrow = null;
                        if (prevElement.querySelector) {
                            tArrow = prevElement.querySelector('.thread-arrow');
                        } else {
                            var tImgs = prevElement.getElementsByTagName('img');
                            for (var k = 0; k < tImgs.length; k++) {
                                if (hasClass(tImgs[k], 'thread-arrow')) {
                                    tArrow = tImgs[k];
                                    break;
                                }
                            }
                        }

                        if (tArrow) {
                            tArrow.src = '/resources/twemoji/25b6.gif';
                            tArrow.alt = '>';
                            break;
                        }
                    }
                    prevElement = prevElemSibling(prevElement);
                }
            }
        }
    } catch (e) {
        // localStorage might not be available
    }

    // Background server list sync (#refresh-sync)
    // Only trigger if we are on the server list page (not viewing a specific server)
    // and if we haven't synced in this session yet.
    var pathParts = window.location.pathname.split('/').filter(Boolean);
    var isServerListPage =
        pathParts.length === 1 && (pathParts[0] === 'server' || pathParts[0] === 'server.html');

    if (isServerListPage && typeof sessionStorage !== 'undefined') {
        if (!sessionStorage.getItem('discross_synced')) {
            var iframe = document.createElement('iframe');
            iframe.style.display = 'none';
            // Use the templated variables replaced by the server
            var clientId = '{{DISCORD_CLIENT_ID}}';
            var redirectUri = encodeURIComponent('{{DISCORD_REDIRECT_URL}}');
            iframe.src =
                'https://discord.com/oauth2/authorize?client_id=' +
                clientId +
                '&response_type=code&redirect_uri=' +
                redirectUri +
                '&scope=identify+guilds&prompt=none&state=sync';

            document.body.appendChild(iframe);
            sessionStorage.setItem('discross_synced', 'true');

            // Listen for completion message from the iframe
            var onMessage = function (event) {
                if (event.data === 'discross_sync_complete') {
                    // Sync complete - server-side refresh will handle it next time
                }
            };

            if (window.addEventListener) {
                window.addEventListener('message', onMessage, false);
            } else if (window.attachEvent) {
                window.attachEvent('onmessage', onMessage);
            }
        }
    }
};

// Drag-and-drop reordering of the server rail. Purely progressive: only wired up
// when the browser has HTML5 drag-and-drop, addEventListener, JSON and XHR;
// older browsers keep plain links and the saved order is still applied
// server-side when the page renders.
(function () {
    function init() {
        if (
            !document.querySelectorAll ||
            !document.addEventListener ||
            !window.JSON ||
            !window.XMLHttpRequest ||
            !('draggable' in document.createElement('div'))
        ) {
            return;
        }
        var links = document.querySelectorAll('.server-rail a.server-link');
        if (!links.length) return;
        var dragged = null;

        function currentOrder() {
            var out = [];
            var all = document.querySelectorAll('.server-rail a.server-link');
            for (var i = 0; i < all.length; i++) {
                out.push(all[i].getAttribute('data-server-id'));
            }
            return out;
        }

        function save() {
            try {
                var xhr = new XMLHttpRequest();
                xhr.open('POST', '/reorderServers', true);
                xhr.setRequestHeader('Content-Type', 'application/json');
                xhr.send(JSON.stringify({ order: currentOrder() }));
            } catch (e) {
                // best effort
            }
        }

        // Each tile is <a>, then its <br>; move them together.
        function move(el, before) {
            var br = nextElemSibling(el);
            var parent = el.parentNode;
            var ref = before;
            parent.insertBefore(el, ref);
            if (br && br.tagName === 'BR') parent.insertBefore(br, ref);
        }

        function wire(a) {
            a.setAttribute('draggable', 'true');
            a.addEventListener('dragstart', function (e) {
                dragged = a;
                addClass(a, 'server-dragging');
                if (e.dataTransfer) {
                    e.dataTransfer.effectAllowed = 'move';
                    try {
                        e.dataTransfer.setData('text/plain', a.getAttribute('data-server-id'));
                    } catch (err) {
                        // IE only allows 'Text'
                        e.dataTransfer.setData('Text', a.getAttribute('data-server-id'));
                    }
                }
            });
            a.addEventListener('dragover', function (e) {
                if (!dragged || dragged === a) return;
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
            });
            a.addEventListener('drop', function (e) {
                e.preventDefault();
                if (!dragged || dragged === a) return;
                var list = document.querySelectorAll('.server-rail a.server-link');
                var from = -1;
                var to = -1;
                for (var i = 0; i < list.length; i++) {
                    if (list[i] === dragged) from = i;
                    if (list[i] === a) to = i;
                }
                if (from < to) {
                    // dropping downward: place after target tile (and its <br>)
                    var after = nextElemSibling(a);
                    if (after && after.tagName === 'BR') after = nextElemSibling(after);
                    move(dragged, after);
                } else {
                    move(dragged, a);
                }
                save();
            });
            a.addEventListener('dragend', function () {
                if (dragged) removeClass(dragged, 'server-dragging');
                dragged = null;
            });
        }

        for (var i = 0; i < links.length; i++) wire(links[i]);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, false);
    } else {
        init();
    }
})();
