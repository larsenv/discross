// IE8/Opera 9.x-compatible element sibling traversal helpers.
// nextElementSibling and previousElementSibling are IE9+ only.
function nextElemSibling(el) {
    var s = el.nextSibling;
    while (s && s.nodeType !== 1) { s = s.nextSibling; }
    return s;
}
function prevElemSibling(el) {
    var s = el.previousSibling;
    while (s && s.nodeType !== 1) { s = s.previousSibling; }
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
    el.className = el.className.replace(re, ' ').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
}
function toggleClass(el, cls) {
    if (hasClass(el, cls)) { removeClass(el, cls); return false; }
    addClass(el, cls); return true;
}

// Category collapse/expand functionality (#17)
function toggleCategory(element) {
    var arrow = element.querySelector('.category-arrow');
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
            arrow.src = isCollapsed ? '/resources/twemoji/25b6.gif' : '/resources/twemoji/1f53d.gif';
            arrow.alt = isCollapsed ? '>' : 'v';
        }

        // Store state in localStorage
        try {
            var categoryId = categoryDiv.id;
            if (categoryId) {
                localStorage.setItem(categoryId, isCollapsed ? 'collapsed' : 'expanded');
            }
        } catch (e) {
            // localStorage might not be available
        }
    }
}

// Thread group collapse/expand functionality
function toggleThreads(element) {
    var arrow = element.querySelector('.thread-arrow');
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
            arrow.src = isCollapsed ? '/resources/twemoji/25b6.gif' : '/resources/twemoji/1f53d.gif';
            arrow.alt = isCollapsed ? '>' : 'v';
        }

        try {
            var id = threadDiv.id;
            if (id) {
                localStorage.setItem(id, isCollapsed ? 'collapsed' : 'expanded');
            }
        } catch (e) {
            // localStorage might not be available
        }
    }
}

// Restore category and thread group states on page load
window.onload = function() {
    try {
        var categories = document.querySelectorAll('.category-channels');
        for (var i = 0; i < categories.length; i++) {
            var cat = categories[i];
            var state = localStorage.getItem(cat.id);
            if (state === 'collapsed') {
                addClass(cat, 'collapsed');

                // Find the previous category link to update arrow
                var prevSibling = prevElemSibling(cat);
                while (prevSibling) {
                    if (prevSibling.tagName === 'A' && prevSibling.onclick) {
                        var arrow = prevSibling.querySelector('.category-arrow');
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

        var threadGroups = document.querySelectorAll('.thread-channels');
        for (var tgIndex = 0; tgIndex < threadGroups.length; tgIndex++) {
            var tg = threadGroups[tgIndex];
            var tgState = localStorage.getItem(tg.id);
            if (tgState === 'collapsed') {
                addClass(tg, 'collapsed');

                var prevElement = prevElemSibling(tg);
                while (prevElement) {
                    if (prevElement.tagName === 'A' && prevElement.onclick) {
                        var tArrow = prevElement.querySelector('.thread-arrow');
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
};
