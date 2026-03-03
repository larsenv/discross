// Category collapse/expand functionality (#17)
function toggleCategory(element) {
    var arrow = element.querySelector('.category-arrow');
    // Find the category-channels div - it should be a sibling after potentially a BR
    var categoryDiv = null;
    var sibling = element.nextElementSibling;
    
    // Skip over BR tags to find the category-channels div
    while (sibling) {
        if (sibling.classList && sibling.classList.contains('category-channels')) {
            categoryDiv = sibling;
            break;
        }
        sibling = sibling.nextElementSibling;
    }
    
    if (categoryDiv) {
        var isCollapsed = categoryDiv.classList.toggle('collapsed');
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
    var sibling = element.nextElementSibling;

    while (sibling) {
        if (sibling.classList && sibling.classList.contains('thread-channels')) {
            threadDiv = sibling;
            break;
        }
        sibling = sibling.nextElementSibling;
    }

    if (threadDiv) {
        var isCollapsed = threadDiv.classList.toggle('collapsed');
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
                cat.classList.add('collapsed');
                
                // Find the previous category link to update arrow
                var prevSibling = cat.previousElementSibling;
                while (prevSibling) {
                    if (prevSibling.tagName === 'A' && prevSibling.onclick) {
                        var arrow = prevSibling.querySelector('.category-arrow');
                        if (arrow) {
                            arrow.src = '/resources/twemoji/25b6.gif';
                            arrow.alt = '>';
                            break;
                        }
                    }
                    prevSibling = prevSibling.previousElementSibling;
                }
            }
        }

        var threadGroups = document.querySelectorAll('.thread-channels');
        for (var tgIndex = 0; tgIndex < threadGroups.length; tgIndex++) {
            var tg = threadGroups[tgIndex];
            var tgState = localStorage.getItem(tg.id);
            if (tgState === 'collapsed') {
                tg.classList.add('collapsed');

                var prevElement = tg.previousElementSibling;
                while (prevElement) {
                    if (prevElement.tagName === 'A' && prevElement.onclick) {
                        var tArrow = prevElement.querySelector('.thread-arrow');
                        if (tArrow) {
                            tArrow.src = '/resources/twemoji/25b6.gif';
                            tArrow.alt = '>';
                            break;
                        }
                    }
                    prevElement = prevElement.previousElementSibling;
                }
            }
        }
    } catch (e) {
        // localStorage might not be available
    }
};
