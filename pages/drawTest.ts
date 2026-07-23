'use strict';
const fs = require('fs');
const { renderTemplate, resolveTheme, getTemplate, loadAndRenderPageTemplate } = require('./utils');

// Standalone harness for the "one canvas instead of five" experiment on the Old 3DS.
// It serves the shared single-canvas draw.js engine inside the same 320x240 layout
// budget the retired DSiPaint-derived page used, plus a live event/coordinate
// readout, so the two engines could be compared on real hardware. The experiment
// settled yes — the five-canvas page is gone and draw.js repaints itself — and this
// is kept as the diagnostic rig for legacy-browser drawing bugs. Intentionally
// unauthenticated and channel-less: nothing here can send a message, and the Export
// button only measures toDataURL().
const test_template = loadAndRenderPageTemplate('draw-test-old3ds');

const NO_CACHE_HTML_HEADERS = {
    'Content-Type': 'text/html',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
};

exports.processDrawTest = function processDrawTest(req, res) {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const channelID = parsedUrl.searchParams.get('channel') || '';
    const { themeClass } = resolveTheme(req);

    let html = renderTemplate(test_template, {
        COMMON_HEAD: getTemplate('head', 'partials'),
        WHITE_THEME_ENABLED: themeClass,
        CHANNEL_ID: channelID,
        PAGE_TITLE: 'Old 3DS single-canvas draw test - Discross',
        SEO_METADATA: '',
    });

    // Inline draw.js for the same reason draw.ts does: on Wii/DSi Opera 9 an
    // external <script src> can execute before the canvas exists, and draw.js
    // does getElementById('sketchpad') on its very first line.
    try {
        const drawJs = fs.readFileSync('pages/static/js/draw.js', 'utf-8');
        html = html.replace(
            /<script src="\/js\/draw\.js[^"]*"><\/script>/,
            '<script>\n' + drawJs + '\n</script>'
        );
    } catch (ex) {
        // Fall back to the external script tag.
    }

    res.writeHead(200, NO_CACHE_HTML_HEADERS);
    res.end(html);
};
