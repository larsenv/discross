'use strict';
const { getTemplate, render } = require('./utils');
const { formatDiscordTimestamp } = require('../src/timezoneUtils');
const md = require('markdown-it')({
    breaks: true,
    linkify: true,
    html: false,
}).disable(['blockquote']);
const hljs = require('highlight.js');

// Color map from highlight.js token classes to atom-one-dark hex colors.
const HLJS_INLINE_STYLES = {
    'hljs-keyword': 'color:#c678dd',
    'hljs-doctag': 'color:#c678dd',
    'hljs-formula': 'color:#c678dd',
    'hljs-comment': 'color:#5c6370;font-style:italic',
    'hljs-quote': 'color:#5c6370;font-style:italic',
    'hljs-string': 'color:#98c379',
    'hljs-addition': 'color:#98c379',
    'hljs-attribute': 'color:#98c379',
    'hljs-regexp': 'color:#98c379',
    'hljs-literal': 'color:#56b6c2',
    'hljs-number': 'color:#d19a66',
    'hljs-attr': 'color:#d19a66',
    'hljs-type': 'color:#d19a66',
    'hljs-variable': 'color:#d19a66',
    'hljs-template-variable': 'color:#d19a66',
    'hljs-selector-class': 'color:#d19a66',
    'hljs-selector-attr': 'color:#d19a66',
    'hljs-selector-pseudo': 'color:#d19a66',
    'hljs-built_in': 'color:#e6c07b',
    'hljs-title': 'color:#61aeee',
    'hljs-bullet': 'color:#61aeee',
    'hljs-link': 'color:#61aeee',
    'hljs-meta': 'color:#61aeee',
    'hljs-selector-id': 'color:#61aeee',
    'hljs-symbol': 'color:#61aeee',
    'hljs-name': 'color:#e06c75',
    'hljs-section': 'color:#e06c75',
    'hljs-selector-tag': 'color:#e06c75',
    'hljs-deletion': 'color:#e06c75',
    'hljs-subst': 'color:#e06c75',
    'hljs-strong': 'font-weight:700',
    'hljs-emphasis': 'font-style:italic',
};

function applyInlineStyles(html) {
    return html.replace(/<span class="([^"]+)">/g, (match, classes) => {
        const styles = classes
            .split(' ')
            .filter((cls) => /^[\w-]+$/.test(cls))
            .map((cls) => HLJS_INLINE_STYLES[cls])
            .filter(Boolean)
            .join(';');
        return styles ? `<span style="${styles}">` : '<span>';
    });
}

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function highlightCode(code, lang) {
    if (!lang) return escapeHtml(code);
    try {
        const raw = hljs.getLanguage(lang)
            ? hljs.highlight(code, { language: lang }).value
            : hljs.highlightAuto(code).value;
        return applyInlineStyles(raw);
    } catch (e) {
        return escapeHtml(code);
    }
}

function renderDiscordMarkdown(text, options: { barColor?: string; timezone?: string } = {}) {
    if (!text) return '';

    const barColor = options.barColor || '#808080';
    const timezone = options.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

    // Strip the private-use marker characters used for internal placeholders
    // below. Discord allows them in message content, so without this a message
    // containing a literal "\uE000CODEINLINE0\uE001" (with no real code span)
    // indexes past the placeholder array and crashes rendering of the whole
    // channel page for everyone.
    text = text.replace(/[\uE000\uE001]/g, '');

    text = text.replace(/\u2018|\u2019/g, "'").replace(/\u201C|\u201D/g, '"');

    // Tidy stray spaces just inside emphasis markers. The captured text must not
    // cross another marker or a newline: with a lazy `.+?` a match could run from
    // one span into the next and swallow the space before it, so
    // "**a**! some *b*" lost the space before *b*.
    text = text
        .replace(/(?<!\*)\*\*\s+([^*\n]+?)\s+\*\*/g, '**$1**')
        .replace(/(?<!\*)\*\*\s+([^*\n]+?)\*\*/g, '**$1**')
        .replace(/(?<!\*)\*\*([^*\n]+?)\s+\*\*/g, '**$1**')
        .replace(/(?<!_)__\s+([^_\n]+?)\s+__/g, '__$1__')
        .replace(/(?<!_)__\s+([^_\n]+?)__/g, '__$1__')
        .replace(/(?<!_)__([^_\n]+?)\s+__/g, '__$1__')
        .replace(/(?<!\*)\*(?!\*)\s+([^*\n]+?)\s+\*(?!\*)/g, '*$1*')
        .replace(/(?<!\*)\*(?!\*)\s+([^*\n]+?)\*(?!\*)/g, '*$1*')
        .replace(/(?<!\*)\*(?!\*)([^*\n]+?)\s+\*(?!\*)/g, '*$1*');

    const codePlaceholders = [];
    const underlinePlaceholders = [];
    const spoilerPlaceholders = [];
    const headerPlaceholders = [];
    const bulletListPlaceholders = [];
    const blockQuotePlaceholders = [];
    const subtextPlaceholders = [];
    const timestampPlaceholders = [];

    // Protect blocks from markdown-it processing using unique markers
    text = text.replace(
        /```(?:(\w+)(?:\r?\n|\r)|(?:\r?\n|\r))?([\s\S]*?)```/g,
        function (match, lang, content) {
            const index = codePlaceholders.length;
            const trimmedContent = (content || '').replace(/^\s*\n|\n\s*$/g, '');
            codePlaceholders.push({ type: 'block', content: trimmedContent, lang: lang || '' });
            return `\uE000CODEBLOCK${index}\uE001`;
        }
    );

    text = text.replace(/`([^`]*)`/g, function (match, content) {
        const index = codePlaceholders.length;
        codePlaceholders.push({ type: 'inline', content: content });
        return `\uE000CODEINLINE${index}\uE001`;
    });

    text = text.replace(/<t:(\d+):?([A-Za-z])?>/g, function (match, timestamp, format) {
        const index = timestampPlaceholders.length;
        timestampPlaceholders.push({ timestamp: parseInt(timestamp, 10), format: format || 'f' });
        return `\uE000TIMESTAMP${index}\uE001`;
    });

    text = text.replace(/___(.+?)___/g, '***$1***');
    text = text.replace(/__(.+?)__/g, function (match, content) {
        const index = underlinePlaceholders.length;
        underlinePlaceholders.push(content);
        return `\uE000UNDERLINE${index}\uE001`;
    });

    text = text.replace(/\|\|([\s\S]+?)\|\|/g, function (match, content) {
        const index = spoilerPlaceholders.length;
        spoilerPlaceholders.push(content);
        return `\uE000SPOILER${index}\uE001`;
    });

    const lines = text.split('\n');
    const processedLines = [];
    let inList = false;
    let currentList = [];
    let inQuote = false;
    let currentQuoteList = [];
    let inMultiLineQuote = false;
    const multiLineQuoteContent = [];

    function flushAccumulators() {
        if (inList) {
            const listIndex = bulletListPlaceholders.length;
            bulletListPlaceholders.push(currentList.slice());
            processedLines.push(`\uE000BULLETLIST${listIndex}\uE001`);
            currentList = [];
            inList = false;
        }
        if (inQuote) {
            const quoteIndex = blockQuotePlaceholders.length;
            blockQuotePlaceholders.push(currentQuoteList.slice());
            processedLines.push(`\uE000BLOCKQUOTE${quoteIndex}\uE001`);
            currentQuoteList = [];
            inQuote = false;
        }
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (inMultiLineQuote) {
            multiLineQuoteContent.push(line);
            continue;
        }
        if (line.startsWith('>>>')) {
            flushAccumulators();
            inMultiLineQuote = true;
            multiLineQuoteContent.push(line.substring(3).trim());
            continue;
        }
        if (line.match(/^>\s(?!>).*$/)) {
            if (inList) flushAccumulators();
            inQuote = true;
            currentQuoteList.push(line.replace(/^>\s/, ''));
            continue;
        } else if (inQuote) {
            flushAccumulators();
        }
        const headerMatch = line.match(/^(#{1,3})\s+(.+)$/);
        if (headerMatch) {
            flushAccumulators();
            const index = headerPlaceholders.length;
            headerPlaceholders.push({ level: headerMatch[1].length, content: headerMatch[2] });
            processedLines.push(`\uE000HEADER${index}\uE001`);
            continue;
        }
        const subtextMatch = line.match(/^\s*-#\s+(.+)$/);
        if (subtextMatch) {
            flushAccumulators();
            const index = subtextPlaceholders.length;
            subtextPlaceholders.push(subtextMatch[1]);
            processedLines.push(`\uE000SUBTEXT${index}\uE001`);
            continue;
        }
        const listMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
        if (listMatch) {
            inList = true;
            currentList.push({ indent: listMatch[1].length, content: listMatch[2] });
            continue;
        } else if (inList) {
            flushAccumulators();
        }
        processedLines.push(line);
    }
    flushAccumulators();
    if (inMultiLineQuote) {
        const index = blockQuotePlaceholders.length;
        blockQuotePlaceholders.push(multiLineQuoteContent);
        processedLines.push(`\uE000BLOCKQUOTE${index}\uE001`);
    }

    // Discord maps every newline to a line break, so a blank line between two
    // lines of text is an empty line (and three newlines are two empty lines).
    // Markdown would instead start a new paragraph and collapse any run of
    // blank lines into one gap, so each blank line between ordinary text
    // becomes a marker line that keeps the paragraph going and renders empty.
    // Blank lines beside block elements (headers, lists, quotes, code) keep
    // the paragraph break, whose margin already spaces them like Discord.
    const isBlockLine = (line) =>
        /^(?:HEADER|BULLETLIST|BLOCKQUOTE|SUBTEXT|CODEBLOCK)\d+$/.test(line.trim());
    const nonBlank = processedLines.map((line) => line.trim() !== '');
    const linesWithBlanks = processedLines.map((line, i) => {
        if (nonBlank[i]) return line;
        const prev = nonBlank.lastIndexOf(true, i);
        const next = nonBlank.indexOf(true, i);
        if (prev === -1 || next === -1) return line;
        if (isBlockLine(processedLines[prev]) || isBlockLine(processedLines[next])) return line;
        return 'BLANK';
    });

    text = linesWithBlanks.join('\n');
    let rendered = md
        .render(text)
        .trim()
        .replace(/BLANK/g, '');

    // Remove redundant <br> tags before and after block-level placeholders that markdown-it adds due to breaks:true
    rendered = rendered.replace(
        /<br>(\uE000(HEADER|BULLETLIST|BLOCKQUOTE|CODEBLOCK|SUBTEXT)\d+\uE001)/g,
        '$1'
    );
    rendered = rendered.replace(
        /(\uE000(HEADER|BULLETLIST|BLOCKQUOTE|CODEBLOCK|SUBTEXT)\d+\uE001)<br>/g,
        '$1'
    );

    if (
        rendered.startsWith('<p>') &&
        rendered.endsWith('</p>') &&
        (rendered.match(/<p>/g) || []).length === 1
    ) {
        rendered = rendered.slice(3, -4);
    }

    function resolveNested(str) {
        str = str.replace(/\uE000SPOILER(\d+)\uE001/g, (m, i) => {
            return render('discordMarkdown/spoiler', {
                '{$SPOILER_CONTENT}': md.renderInline(spoilerPlaceholders[parseInt(i, 10)]),
            });
        });
        str = str.replace(/\uE000UNDERLINE(\d+)\uE001/g, (m, i) => {
            return render('discordMarkdown/underline', {
                CONTENT: md.renderInline(underlinePlaceholders[parseInt(i, 10)]),
            });
        });
        return str;
    }

    let final = resolveNested(rendered);
    final = final.replace(/\uE000HEADER(\d+)\uE001/g, (m, i) => {
        const h = headerPlaceholders[parseInt(i, 10)];
        return render('discordMarkdown/header', {
            LEVEL: h.level.toString(),
            CONTENT: resolveNested(md.renderInline(h.content)),
        });
    });
    final = final.replace(/\uE000SUBTEXT(\d+)\uE001/g, (m, i) => {
        return render('discordMarkdown/subtext', {
            CONTENT: resolveNested(md.renderInline(subtextPlaceholders[parseInt(i, 10)])),
        });
    });
    final = final.replace(/\uE000BLOCKQUOTE(\d+)\uE001/g, (m, i) => {
        const lines = blockQuotePlaceholders[parseInt(i, 10)];
        const processed = lines
            .map((l) => (l ? resolveNested(md.renderInline(l)) : '\u00A0'))
            .join(getTemplate('br', 'misc'));
        return render('discordMarkdown/blockquote', {
            BAR_COLOR: barColor,
            CONTENT: processed,
        });
    });
    final = final.replace(/\uE000BULLETLIST(\d+)\uE001/g, (m, i) => {
        const items = bulletListPlaceholders[parseInt(i, 10)];
        let html = '';
        let currentLevel = 0;
        const stack = [];

        items.forEach((item) => {
            const level = Math.floor(item.indent / 2);
            while (level > currentLevel) {
                stack.push(html);
                html = '';
                currentLevel++;
            }
            while (level < currentLevel) {
                const inner = render('discordMarkdown/list', {
                    CONTENT: html,
                });
                html = stack.pop() + inner;
                currentLevel--;
            }
            html += render('discordMarkdown/list-item', {
                CONTENT: resolveNested(md.renderInline(item.content)),
            });
        });

        while (currentLevel > 0) {
            const inner = render('discordMarkdown/list', {
                CONTENT: html,
            });
            html = stack.pop() + inner;
            currentLevel--;
        }

        return render('discordMarkdown/list', { CONTENT: html });
    });
    final = final.replace(/\uE000CODEINLINE(\d+)\uE001/g, (m, i) => {
        return render('discordMarkdown/inline-code', {
            CONTENT: escapeHtml(codePlaceholders[parseInt(i, 10)].content),
        });
    });
    final = final.replace(/\uE000CODEBLOCK(\d+)\uE001/g, (m, i) => {
        const item = codePlaceholders[parseInt(i, 10)];
        return render('discordMarkdown/block-code', {
            LANG_CLASS: item.lang ? ` class="language-${item.lang}"` : '',
            CONTENT: highlightCode(item.content, item.lang),
        });
    });
    final = final.replace(
        /<a\s+href="https:\/\/discord\.com\/channels\/\d{16,20}\/(\d{16,20})\/(\d{16,20})"/gi,
        '<a href="/channels/$1/$2"'
    );
    final = final.replace(
        /<a\s+href="https?:\/\/(?:www\.)?(transfer\.archivete\.am|transfer\.notkiska\.pw|x0\.at)\/([^"]+)"/gi,
        (match, host, path) => {
            const rawUrl = `https://${host}/${path}`;
            const proxied = `/fileProxy/external/${Buffer.from(rawUrl).toString('base64')}`;
            return `<a href="${proxied}"`;
        }
    );
    final = final.replace(/\uE000TIMESTAMP(\d+)\uE001/g, (m, i) => {
        const ts = timestampPlaceholders[parseInt(i, 10)];
        const formatted = formatDiscordTimestamp(ts.timestamp, ts.format || 'f', timezone);
        return render('discordMarkdown/timestamp', { CONTENT: formatted });
    });

    return final;
}

module.exports = { renderDiscordMarkdown };
