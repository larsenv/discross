'use strict';

/**
 * Rewrites a finished page into markup that HTML 3.2-era browsers (the
 * Dreamcast's DreamPassport/XDP, PlanetWeb and DreamKey, WebTV, Mosaic, ...)
 * can draw. Those browsers:
 *   - ignore most CSS, so anything hidden with style="display: none" shows up
 *     (the emoji picker, passkey buttons, JS-only widgets) and images sized
 *     only in CSS draw at their full size;
 *   - have no <button>, <details> or <summary>;
 *   - sit on a dial-up modem with a few MB of RAM, where the 100 KB stylesheet,
 *     web fonts and scripts make every page crawl.
 */

const VOID_TAGS = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr',
]);

const TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;

/**
 * Finds the index just past the element whose opening tag starts at `start`,
 * by counting nested tags of the same name. Returns -1 if it never closes.
 */
function findElementEnd(html, start, tagName) {
    const tagRe = new RegExp(`<(/?)${tagName}\\b[^>]*>`, 'gi');
    tagRe.lastIndex = start;
    let depth = 0;
    let match;
    while ((match = tagRe.exec(html))) {
        if (match[1]) {
            depth--;
            if (depth === 0) return match.index + match[0].length;
        } else if (!match[0].endsWith('/>')) {
            depth++;
        }
    }
    return -1;
}

/** Removes every element whose opening tag matches `test`, contents included. */
function removeElements(html, test) {
    let out = '';
    let pos = 0;
    TAG_RE.lastIndex = 0;
    let match;
    while ((match = TAG_RE.exec(html))) {
        const tag = match[0];
        const name = match[1].toLowerCase();
        if (!test(tag, name)) continue;
        let end;
        if (VOID_TAGS.has(name) || tag.endsWith('/>')) {
            end = match.index + tag.length;
        } else {
            end = findElementEnd(html, match.index, name);
            if (end === -1) continue;
        }
        out += html.slice(pos, match.index);
        pos = end;
        TAG_RE.lastIndex = end;
    }
    return out + html.slice(pos);
}

function getAttr(tag, name) {
    const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
    if (!match) return null;
    return match[2] ?? match[3] ?? match[4] ?? '';
}

function isHiddenByStyle(tag) {
    const style = getAttr(tag, 'style');
    return style !== null && /(^|;)\s*display\s*:\s*none/i.test(style);
}

/** Drops on* handlers and turns CSS pixel sizes on images into attributes. */
function rewriteTag(tag, name) {
    let out = tag.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '');
    if (name === 'img') {
        const style = getAttr(out, 'style') || '';
        for (const dim of ['width', 'height']) {
            if (getAttr(out, dim) !== null) continue;
            const px = style.match(new RegExp(`(^|;)\\s*${dim}\\s*:\\s*(\\d+)px`, 'i'));
            if (px) out = out.replace(/^<img\b/i, `<img ${dim}="${px[2]}"`);
        }
    }
    return out;
}

function stripTags(html) {
    return html
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * <button>Label</button> is HTML 4; turn submit buttons into
 * <input type="submit">. Script-only buttons (type="button") are dropped.
 */
function replaceButtons(html) {
    return html.replace(
        /<button\b([^>]*)>([\s\S]*?)<\/button>/gi,
        (whole, attrs, inner, offset) => {
            const type = (getAttr(`<b${attrs}>`, 'type') || 'submit').toLowerCase();
            if (type !== 'submit') return '';
            // Outside a form a button can only have been wired up by a script.
            const before = html.slice(0, offset).toLowerCase();
            if (before.lastIndexOf('<form') <= before.lastIndexOf('</form')) return '';
            const label = stripTags(inner) || 'Submit';
            const name = getAttr(`<b${attrs}>`, 'name');
            // A named button submits its own value, which an <input type="submit">
            // can only carry as its label; keep the value so the server still sees it.
            const value = name !== null ? getAttr(`<b${attrs}>`, 'value') || label : label;
            const nameAttr = name !== null ? ` name="${name}"` : '';
            return `<input type="submit"${nameAttr} value="${value.replace(/"/g, '&quot;')}" />`;
        }
    );
}

/**
 * <details>/<summary> are unknown, so their whole body would always show. Keep
 * the summary, and the body only when the server rendered it open.
 */
function flattenDetails(html) {
    let guard = 0;
    let start;
    while ((start = html.search(/<details\b/i)) !== -1 && guard++ < 50) {
        const end = findElementEnd(html, start, 'details');
        if (end === -1) break;
        const block = html.slice(start, end);
        const openTag = block.match(/^<details\b[^>]*>/i)[0];
        const isOpen = /\sopen(\s|>|=|\/)/i.test(openTag);
        const inner = block.slice(openTag.length, block.length - '</details>'.length);
        const summaryMatch = inner.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i);
        const summary = summaryMatch ? summaryMatch[1] : '';
        const body = summaryMatch ? inner.replace(summaryMatch[0], '') : inner;
        html = html.slice(0, start) + summary + (isOpen ? body : '') + html.slice(end);
    }
    return html;
}

function downgradeHtml(html) {
    // Scripts, styles and anything only scripts could use.
    html = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '');
    html = html.replace(/<link\b[^>]*>/gi, '');
    html = html.replace(/<style\b[\s\S]*?<\/style>/gi, '');
    html = html.replace(/<!--[\s\S]*?-->/g, '');
    html = html.replace(/<meta\b(?![^>]*http-equiv)[^>]*>/gi, '');

    html = removeElements(
        html,
        (tag, name) =>
            isHiddenByStyle(tag) ||
            (name === 'input' && /type\s*=\s*["']?file/i.test(tag) && /display/i.test(tag)) ||
            (name === 'a' && /href\s*=\s*["']\s*javascript:/i.test(tag))
    );

    html = flattenDetails(html);
    html = replaceButtons(html);
    html = html.replace(TAG_RE, (tag, name) => rewriteTag(tag, name.toLowerCase()));

    // Indentation and blank lines are pure overhead on a modem; <pre> (code
    // blocks) and <textarea> keep theirs.
    return html
        .split(/(<(pre|textarea)\b[\s\S]*?<\/\2>)/i)
        .map((part, i) => {
            if (i % 3 === 2) return '';
            if (i % 3 === 1) return part;
            return part.replace(/\n\s+/g, '\n');
        })
        .join('');
}

module.exports = { downgradeHtml };
