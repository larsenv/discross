// Nintendo 3DS/DSi Auto-scroll Compatibility Script
// Detects Nintendo devices by screen height and applies scrolling fixes

(function() {
  // Check if this is a Nintendo device (3DS/DSi) by screen height
  // 3DS upper screen: 400x240px, lower screen: 320x240px
  // DSi screens: 256x192px
  const isNintendoDevice = screen.height <= 250;

  if (!isNintendoDevice) {
    // Not a Nintendo device, exit early
    return;
  }

  // Create debug marker to show on Nintendo devices only
  let debugMarker = null;
  function createDebugMarker() {
    debugMarker = document.createElement('div');
    debugMarker.id = 'nintendo-debug';
    debugMarker.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      background: rgba(0, 0, 0, 0.8);
      color: #00ff00;
      font-family: monospace;
      font-size: 10px;
      padding: 4px;
      z-index: 999999;
      pointer-events: none;
    `;
    document.body.appendChild(debugMarker);
  }

  function updateDebug(message) {
    if (!debugMarker) {
      createDebugMarker();
    }
    debugMarker.innerHTML = `3DS DETECTED w:${screen.width} h:${screen.height}<br>${message}`;
  }

  // Enhanced scroll function specifically for Nintendo browsers
  function scrollToBottomNintendo() {
    updateDebug('Attempting to scroll...');

    try {
      // Method 1: Direct window.scrollTo with document height
      const scrollHeight = document.body ? document.body.scrollHeight : 0;
      if (scrollHeight > 0) {
        window.scrollTo(0, scrollHeight);
        updateDebug('Method1: window.scrollTo(0, ' + scrollHeight + ')');

        // Verify it worked after a delay
        setTimeout(function() {
          if (window.scrollY + window.innerHeight >= scrollHeight * 0.9) {
            updateDebug('SUCCESS: Scrolled to bottom');
          } else {
            updateDebug('Method1 failed, trying alternatives...');
            tryAlternativeMethods();
          }
        }, 100);
      } else {
        updateDebug('No scrollHeight, trying alternatives...');
        tryAlternativeMethods();
      }
    } catch (e) {
      updateDebug('ERROR: ' + e.message);
      tryAlternativeMethods();
    }
  }

  function tryAlternativeMethods() {
    // Method 2: Try scrolling by a very large number
    try {
      window.scrollTo(0, 999999);
      updateDebug('Method2: window.scrollTo(0, 999999)');

      setTimeout(function() {
        if (window.scrollY > 0) {
          updateDebug('SUCCESS: Method2 worked');
        } else {
          updateDebug('Method2 failed');
        }
      }, 100);
    } catch (e) {
      updateDebug('Method2 ERROR: ' + e.message);

      // Method 3: Try document.body.scrollTop
      try {
        if (document.body) {
          document.body.scrollTop = document.body.scrollHeight;
          updateDebug('Method3: document.body.scrollTop');
        }
      } catch (e2) {
        updateDebug('All methods failed: ' + e2.message);
      }
    }
  }

  // Override the existing scrollToBottom function if it exists
  if (typeof window.scrollToBottom === 'function') {
    const originalScrollToBottom = window.scrollToBottom;
    window.scrollToBottom = function() {
      updateDebug('Original scrollToBottom called, using Nintendo version');
      scrollToBottomNintendo();
    };
  }

  // Try scrolling at multiple intervals to ensure it works
  function attemptScrollWithDelay() {
    scrollToBottomNintendo();

    // Retry after 100ms
    setTimeout(function() {
      if (window.scrollY === 0) {
        updateDebug('Retrying after 100ms...');
        scrollToBottomNintendo();
      }
    }, 100);

    // Final retry after 200ms
    setTimeout(function() {
      if (window.scrollY === 0) {
        updateDebug('Final retry after 200ms...');
        scrollToBottomNintendo();
      }
    }, 200);
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attemptScrollWithDelay);
  } else {
    attemptScrollWithDelay();
  }

  // Also try on window load
  window.addEventListener('load', function() {
    setTimeout(attemptScrollWithDelay, 50);
  });

  updateDebug('Nintendo compatibility script loaded');
})();

// Add extra bottom padding for 3DS to prevent messages being covered by toolbar
(function add3DSPadding() {
  if (!isNintendoDevice) return;

  const wrapper = document.getElementById('wrapper');
  if (!wrapper || !wrapper.firstElementChild) return;

  const contentDiv = wrapper.firstElementChild;
  const currentPadding = parseInt(getComputedStyle(contentDiv).paddingBottom) || 0;

  if (!contentDiv.hasAttribute('data-3ds-padded')) {
    const newPadding = currentPadding + 70; // Add 70px to existing padding
    contentDiv.style.paddingBottom = newPadding + 'px';
    contentDiv.setAttribute('data-3ds-padded', 'true');
  }
})();
