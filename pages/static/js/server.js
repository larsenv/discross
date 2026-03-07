// Category collapse/expand functionality (#17)
function toggleCategory(element) {
    const arrow = element.querySelector('.category-arrow');
    // Find the category-channels div - it should be a sibling after potentially a BR
    let categoryDiv = null;
    let sibling = element.nextElementSibling;
    
    // Skip over BR tags to find the category-channels div
    while (sibling) {
        if (sibling.classList && sibling.classList.contains('category-channels')) {
            categoryDiv = sibling;
            break;
        }
        sibling = sibling.nextElementSibling;
    }
    
    if (categoryDiv) {
        const isCollapsed = categoryDiv.classList.toggle('collapsed');
        if (arrow) {
            arrow.src = isCollapsed ? '/resources/twemoji/25b6.gif' : '/resources/twemoji/1f53d.gif';
            arrow.alt = isCollapsed ? '>' : 'v';
        }
        
        // Store state in localStorage
        try {
            const categoryId = categoryDiv.id;
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
    const arrow = element.querySelector('.thread-arrow');
    let threadDiv = null;
    let sibling = element.nextElementSibling;

    while (sibling) {
        if (sibling.classList && sibling.classList.contains('thread-channels')) {
            threadDiv = sibling;
            break;
        }
        sibling = sibling.nextElementSibling;
    }

    if (threadDiv) {
        const isCollapsed = threadDiv.classList.toggle('collapsed');
        if (arrow) {
            arrow.src = isCollapsed ? '/resources/twemoji/25b6.gif' : '/resources/twemoji/1f53d.gif';
            arrow.alt = isCollapsed ? '>' : 'v';
        }

        try {
            const id = threadDiv.id;
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
        const categories = document.querySelectorAll('.category-channels');
        for (let i = 0; i < categories.length; i++) {
            const cat = categories[i];
            const state = localStorage.getItem(cat.id);
            if (state === 'collapsed') {
                cat.classList.add('collapsed');
                
                // Find the previous category link to update arrow
                let prevSibling = cat.previousElementSibling;
                while (prevSibling) {
                    if (prevSibling.tagName === 'A' && prevSibling.onclick) {
                        const arrow = prevSibling.querySelector('.category-arrow');
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

        const threadGroups = document.querySelectorAll('.thread-channels');
        for (let tgIndex = 0; tgIndex < threadGroups.length; tgIndex++) {
            const tg = threadGroups[tgIndex];
            const tgState = localStorage.getItem(tg.id);
            if (tgState === 'collapsed') {
                tg.classList.add('collapsed');

                let prevElement = tg.previousElementSibling;
                while (prevElement) {
                    if (prevElement.tagName === 'A' && prevElement.onclick) {
                        const tArrow = prevElement.querySelector('.thread-arrow');
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
