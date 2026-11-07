'use strict';

const escape = require('escape-html');
const { toLocalPath } = require('./utils');
const { wantsSimpleHtml } = require('./retroHtml');
const { isAncientClient, parseUserAgent } = require('./userAgentUtils');

/**
 * /simple?mode=on|off|toggle&return=/path
 *
 * Turns the plain HTML 3.2 pages (see retroHtml.ts) on or off for this browser,
 * for old browsers whose User-Agent gives them away as something newer. The
 * choice is kept in a cookie, and also put on the return URL so it still holds
 * for that page on browsers that drop cookies.
 */
exports.setSimpleMode = function setSimpleMode(req, res) {
    let target = '/';
    let on;
    try {
        const url = new URL(req.url, 'http://localhost');
        const mode = url.searchParams.get('mode');
        on = mode === 'on' ? true : mode === 'off' ? false : !wantsSimpleHtml(req);
        const returnUrl = new URL(
            toLocalPath(url.searchParams.get('return') || req.headers.referer || '/server/'),
            'http://localhost'
        );
        // Keep the session/theme parameters cookieless browsers carry in links.
        for (const [key, value] of url.searchParams) {
            if (key !== 'mode' && key !== 'return' && key !== 'simple') {
                returnUrl.searchParams.set(key, value);
            }
        }
        returnUrl.searchParams.set('simple', on ? '1' : '0');
        target = toLocalPath(returnUrl.pathname + returnUrl.search);
    } catch {
        on = true;
    }
    const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toUTCString();
    res.writeHead(302, {
        'Set-Cookie': [`simple=${on ? 1 : 0}; path=/; expires=${expires}`],
        'Content-Type': 'text/html',
        Location: target,
    });
    res.end();
};

/** /ua: shows what the browser sends, to identify consoles we don't know yet. */
exports.showUserAgent = function showUserAgent(req, res) {
    const ua = req.headers['user-agent'] || '(none)';
    const client = parseUserAgent(req.headers['user-agent']);
    const rows = [
        ['User-Agent', ua],
        ['Accept', req.headers.accept || '(none)'],
        ['Accept-Encoding', req.headers['accept-encoding'] || '(none)'],
        ['Detected as', client ? client.name : 'unknown'],
        ['Old browser by User-Agent', isAncientClient(req.headers['user-agent']) ? 'yes' : 'no'],
        ['Simple HTML now', wantsSimpleHtml(req) ? 'on' : 'off'],
    ]
        .map(([k, v]) => `<tr><td><b>${escape(k)}</b></td><td>${escape(v)}</td></tr>`)
        .join('\n');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(
        `<table border="1" cellpadding="4">\n${rows}\n</table>\n` +
            '<p><a href="/simple?mode=on&amp;return=/ua">Simple HTML on</a> | ' +
            '<a href="/simple?mode=off&amp;return=/ua">Simple HTML off</a> | ' +
            '<a href="/">Home</a></p>'
    );
};
