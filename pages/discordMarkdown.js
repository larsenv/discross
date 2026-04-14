'use strict';
const { renderTemplate, getTemplate } = require('./utils.js');
const md = require('markdown-it')({
    breaks: true,
    linkify: true,
    html: false,
});
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

function renderDiscordMarkdown(text, options = {}) {
    if (!text) return '';

    const tmpl = {
        spoiler: getTemplate('spoiler', 'discordMarkdown'),
    };

    const barColor = options.barColor || '#808080';
    const timezone = options.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

    text = text.replace(/\u2018|\u2019/g, "'").replace(/\u201C|\u201D/g, '"');

    text = text.replace(/\*\*\s+(.+?)\s+\*\*/g, '**$1**');
    text = text.replace(/\*\*\s+(.+?)\*\*/g, '**$1**');
    text = text.replace(/\*\*(.+?)\s+\*\*/g, '**$1**');
    text = text.replace(/__\s+(.+?)\s+__/g, '__$1__');
    text = text.replace(/__\s+(.+?)__/g, '__$1__');
    text = text.replace(/__(.+?)\s+__/g, '__$1__');
    text = text.replace(/\*(?!\*)\s+(.+?)\s+\*(?!\*)/g, '*$1*');
    text = text.replace(/\*(?!\*)\s+(.+?)\*(?!\*)/g, '*$1*');
    text = text.replace(/\*(?!\*)(.+?)\s+\*(?!\*)/g, '*$1*');

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
    let multiLineQuoteContent = [];

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

    text = processedLines.join('\n');
    let rendered = md.render(text).trim();
    if (
        rendered.startsWith('<p>') &&
        rendered.endsWith('</p>') &&
        (rendered.match(/<p>/g) || []).length === 1
    ) {
        rendered = rendered.slice(3, -4);
    }

    function resolveNested(str) {
        str = str.replace(/\uE000SPOILER(\d+)\uE001/g, (m, i) => {
            return renderTemplate(tmpl.spoiler, {
                '{$SPOILER_CONTENT}': md.renderInline(spoilerPlaceholders[parseInt(i, 10)]),
            });
        });
        str = str.replace(/\uE000UNDERLINE(\d+)\uE001/g, (m, i) => {
            return `<u>${md.renderInline(underlinePlaceholders[parseInt(i, 10)])}</u>`;
        });
        return str;
    }

    let final = resolveNested(rendered);
    final = final.replace(/\uE000HEADER(\d+)\uE001/g, (m, i) => {
        const h = headerPlaceholders[parseInt(i, 10)];
        return `<h${h.level}>${resolveNested(md.renderInline(h.content))}</h${h.level}>`;
    });
    final = final.replace(/\uE000SUBTEXT(\d+)\uE001/g, (m, i) => {
        return `<small class="subtext">${resolveNested(md.renderInline(subtextPlaceholders[parseInt(i, 10)]))}</small>`;
    });
    final = final.replace(/\uE000BLOCKQUOTE(\d+)\uE001/g, (m, i) => {
        const lines = blockQuotePlaceholders[parseInt(i, 10)];
        const processed = lines
            .map((l) => (l ? resolveNested(md.renderInline(l)) : '\u00A0'))
            .join('<br>');
        return `<table class="blockquote-container" cellpadding="0" cellspacing="0"><tr><td class="blockquote-bar" style="background:${barColor};"></td><td class="discord-quote">${processed}</td></tr></table>`;
    });
    final = final.replace(/\uE000BULLETLIST(\d+)\uE001/g, (m, i) => {
        const items = bulletListPlaceholders[parseInt(i, 10)];
        let html = '<ul>',
            currentLevel = 0,
            openTags = 1;
        items.forEach((item) => {
            const level = Math.floor(item.indent / 2);
            while (level > currentLevel) {
                html += '<ul>';
                openTags++;
                currentLevel++;
            }
            while (level < currentLevel) {
                html += '</ul>';
                openTags--;
                currentLevel--;
            }
            html += `<li>${resolveNested(md.renderInline(item.content))}</li>`;
        });
        while (openTags > 0) {
            html += '</ul>';
            openTags--;
        }
        return html;
    });
    final = final.replace(
        /\uE000CODEINLINE(\d+)\uE001/g,
        (m, i) => `<code>${escapeHtml(codePlaceholders[parseInt(i, 10)].content)}</code>`
    );
    final = final.replace(/\uE000CODEBLOCK(\d+)\uE001/g, (m, i) => {
        const item = codePlaceholders[parseInt(i, 10)];
        return `<pre><code${item.lang ? ` class="language-${item.lang}"` : ''}>${highlightCode(item.content, item.lang)}</code></pre>`;
    });
    final = final.replace(
        /<a\s+href="https:\/\/discord\.com\/channels\/\d{16,20}\/(\d{16,20})\/(\d{16,20})"/gi,
        '<a href="/channels/$1/$2"'
    );
    final = final.replace(/\uE000TIMESTAMP(\d+)\uE001/g, (m, i) => {
        const ts = timestampPlaceholders[parseInt(i, 10)];
        const date = new Date(ts.timestamp * 1000);
        const now = new Date();
        const formatTime = (dt) =>
            dt.toLocaleString('en-US', {
                timeZone: timezone,
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
            });
        let formatted;
        switch (ts.format) {
            case 'S':
                formatted = date.toLocaleString('en-US', {
                    timeZone: timezone,
                    month: '2-digit',
                    day: '2-digit',
                    year: '2-digit',
                    hour: 'numeric',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: true,
                });
                break;
            case 'f':
                formatted =
                    date.toLocaleString('en-US', {
                        timeZone: timezone,
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                    }) +
                    ' at ' +
                    formatTime(date);
                break;
            case 'F':
                formatted =
                    date.toLocaleString('en-US', {
                        timeZone: timezone,
                        weekday: 'long',
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                    }) +
                    ' at ' +
                    formatTime(date);
                break;
            case 'R':
                const diffMs = date.getTime() - now.getTime();
                const absSec = Math.abs(Math.round(diffMs / 1000));
                const rel = diffMs < 0 ? 'ago' : 'in';
                if (absSec < 60) formatted = `${absSec} seconds ${rel}`;
                else if (absSec < 3600) formatted = `${Math.round(absSec / 60)} minutes ${rel}`;
                else if (absSec < 86400) formatted = `${Math.round(absSec / 3600)} hours ${rel}`;
                else formatted = `${Math.round(absSec / 86400)} days ${rel}`;
                break;
            case 'd':
                formatted = date.toLocaleString('en-US', {
                    timeZone: timezone,
                    month: '2-digit',
                    day: '2-digit',
                    year: '2-digit',
                });
                break;
            case 'D':
                formatted = date.toLocaleString('en-US', {
                    timeZone: timezone,
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                });
                break;
            case 't':
                formatted = formatTime(date);
                break;
            case 'T':
                formatted = date.toLocaleString('en-US', {
                    timeZone: timezone,
                    hour: 'numeric',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: true,
                });
                break;
            default:
                formatted =
                    date.toLocaleString('en-US', {
                        timeZone: timezone,
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                    }) +
                    ' at ' +
                    formatTime(date);
        }
        return `<span class="discord-timestamp">${formatted}</span>`;
    });

    return final;
}

module.exports = { renderDiscordMarkdown };
