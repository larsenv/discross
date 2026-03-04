const md = require('markdown-it')({
  breaks: true,
  linkify: true,
  html: false
});
const hljs = require('highlight.js');

// Color map from highlight.js token classes to atom-one-dark hex colors.
// Using inline styles ensures colors appear even on browsers that have cached
// an older version of main.css or that have limited CSS support.
const HLJS_INLINE_STYLES = {
  'hljs-keyword':        'color:#c678dd',
  'hljs-doctag':         'color:#c678dd',
  'hljs-formula':        'color:#c678dd',
  'hljs-comment':        'color:#5c6370;font-style:italic',
  'hljs-quote':          'color:#5c6370;font-style:italic',
  'hljs-string':         'color:#98c379',
  'hljs-addition':       'color:#98c379',
  'hljs-attribute':      'color:#98c379',
  'hljs-regexp':         'color:#98c379',
  'hljs-literal':        'color:#56b6c2',
  'hljs-number':         'color:#d19a66',
  'hljs-attr':           'color:#d19a66',
  'hljs-type':           'color:#d19a66',
  'hljs-variable':       'color:#d19a66',
  'hljs-template-variable': 'color:#d19a66',
  'hljs-selector-class': 'color:#d19a66',
  'hljs-selector-attr':  'color:#d19a66',
  'hljs-selector-pseudo':'color:#d19a66',
  'hljs-built_in':       'color:#e6c07b',
  'hljs-title':          'color:#61aeee',
  'hljs-bullet':         'color:#61aeee',
  'hljs-link':           'color:#61aeee',
  'hljs-meta':           'color:#61aeee',
  'hljs-selector-id':    'color:#61aeee',
  'hljs-symbol':         'color:#61aeee',
  'hljs-name':           'color:#e06c75',
  'hljs-section':        'color:#e06c75',
  'hljs-selector-tag':   'color:#e06c75',
  'hljs-deletion':       'color:#e06c75',
  'hljs-subst':          'color:#e06c75',
  'hljs-strong':         'font-weight:700',
  'hljs-emphasis':       'font-style:italic',
};

// Convert highlight.js class-based spans to inline-style spans so that
// colors render without requiring an external CSS file.
// Only class names matching the expected highlight.js pattern (alphanumeric + hyphens + underscores)
// are looked up against the HLJS_INLINE_STYLES map; anything else is dropped.
function applyInlineStyles(html) {
  return html.replace(/<span class="([^"]+)">/g, (match, classes) => {
    const styles = classes.split(' ')
      .filter(cls => /^[\w-]+$/.test(cls))
      .map(cls => HLJS_INLINE_STYLES[cls])
      .filter(Boolean)
      .join(';');
    return styles ? `<span style="${styles}">` : '<span>';
  });
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function highlightCode(code, lang) {
  if (!lang) return escapeHtml(code);
  try {
    let raw;
    if (hljs.getLanguage(lang)) {
      raw = hljs.highlight(code, { language: lang }).value;
    } else {
      raw = hljs.highlightAuto(code).value;
    }
    return applyInlineStyles(raw);
  } catch (e) {
    return escapeHtml(code);
  }
}

function renderDiscordMarkdown(text) {
  if (!text) return '';

  // Replace curly/smart apostrophes and quotes with straight ones
  // The Rodin font does not render them properly
  text = text.replace(/\u2018|\u2019/g, "'").replace(/\u201C|\u201D/g, '"');

  const codePlaceholders = [];
  const underlinePlaceholders = [];
  const spoilerPlaceholders = [];
  const headerPlaceholders = [];
  const bulletListPlaceholders = []; 
  const blockQuotePlaceholders = [];
  const subtextPlaceholders = [];

  // Step 0: Protect Code Blocks
  text = text.replace(/```(?:(\w+)(?:\r?\n|\r)|(?:\r?\n|\r))?([\s\S]*?)```/g, function(match, lang, content) {
    const index = codePlaceholders.length;
    // Trim leading and trailing newlines from code content
    const trimmedContent = (content || '').replace(/^\s*\n|\n\s*$/g, '');
    codePlaceholders.push({ type: 'block', content: trimmedContent, lang: lang || '' });
    return `§§CODEBLOCK${index}§§`;
  });

  // Step 0.5: Protect Inline Code
  text = text.replace(/`([^`]*)`/g, function(match, content) {
    const index = codePlaceholders.length;
    codePlaceholders.push({ type: 'inline', content: content });
    return `§§CODEINLINE${index}§§`;
  });

  // Step 1: Protect Bold Italic & Underline
  text = text.replace(/___(.+?)___/g, '***$1***');
  text = text.replace(/__(.+?)__/g, function(match, content) {
    const index = underlinePlaceholders.length;
    underlinePlaceholders.push(content);
    return `§§UNDERLINE${index}§§`;
  });

  // Step 2: Protect Spoilers
  text = text.replace(/\|\|([\s\S]+?)\|\|/g, function(match, content) {
    const index = spoilerPlaceholders.length;
    spoilerPlaceholders.push(content);
    return `§§SPOILER${index}§§`;
  });

  // Step 3: Line-by-Line Processing
  const lines = text.split('\n');
  const processedLines = [];
  
  // State for Lists
  let inList = false;
  let currentList = [];

  // State for Single-line Quotes (>)
  let inQuote = false;
  let currentQuoteList = [];
  
  // State for Multi-line Quotes (>>>)
  let inMultiLineQuote = false;
  let multiLineQuoteContent = [];

  // Helper to flush pending lists/quotes
  function flushAccumulators() {
      // Flush List
      if (inList) {
          const listIndex = bulletListPlaceholders.length;
          bulletListPlaceholders.push(currentList.slice());
          processedLines.push(`§§BULLETLIST${listIndex}§§`);
          currentList = [];
          inList = false;
      }
      // Flush Single-line Quote
      if (inQuote) {
          const quoteIndex = blockQuotePlaceholders.length;
          blockQuotePlaceholders.push(currentQuoteList.slice());
          processedLines.push(`§§BLOCKQUOTE${quoteIndex}§§`);
          currentQuoteList = [];
          inQuote = false;
      }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 3.1: Multi-line Block Quote (>>>)
    if (inMultiLineQuote) {
        multiLineQuoteContent.push(line);
        continue;
    }
    if (line.startsWith('>>>')) {
        flushAccumulators(); 
        const content = line.substring(3).trim(); 
        inMultiLineQuote = true;
        multiLineQuoteContent.push(content);
        continue;
    }

    // 3.2: Single-line Block Quote (>)
    if (line.match(/^>\s?.*$/)) {
        if (inList) flushAccumulators(); 
        inQuote = true;
        const content = line.replace(/^>\s?/, '');
        currentQuoteList.push(content);
        continue;
    } else {
        if (inQuote) flushAccumulators();
    }

    // 3.3: Headers (Levels 1-3)
    const headerMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headerMatch) {
        flushAccumulators();
        const level = headerMatch[1].length;
        const content = headerMatch[2];
        const index = headerPlaceholders.length;
        headerPlaceholders.push({ level, content });
        processedLines.push(`§§HEADER${index}§§`);
        continue;
    }

    // 3.4: Subtext (-# text)
    const subtextMatch = line.match(/^\s*-#\s+(.+)$/);
    if (subtextMatch) {
        flushAccumulators();
        const content = subtextMatch[1];
        const index = subtextPlaceholders.length;
        subtextPlaceholders.push(content);
        processedLines.push(`§§SUBTEXT${index}§§`);
        continue;
    }

    // 3.5: Bullet Lists
    const listMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (listMatch) {
      inList = true;
      currentList.push({ 
          indent: listMatch[1].length, 
          content: listMatch[2]
      });
      continue;
    } else {
      if (inList) flushAccumulators();
    }

    // Normal line
    processedLines.push(line);
  }

  flushAccumulators();
  
  if (inMultiLineQuote) {
      const index = blockQuotePlaceholders.length;
      blockQuotePlaceholders.push(multiLineQuoteContent);
      processedLines.push(`§§BLOCKQUOTE${index}§§`);
  }
  
  text = processedLines.join('\n');

  // Step 4: Markdown Render
  let result = md.renderInline(text);

  // Helper to resolve nested formatting
  function resolveNested(str) {
      // Restore Spoilers - Wii-compatible table-based implementation
      str = str.replace(/§§SPOILER(\d+)§§/g, function(m, i) {
          const content = spoilerPlaceholders[parseInt(i)];
          const rendered = md.renderInline(content); 
          // Use table-based spoiler for Wii Internet Channel compatibility
          // The show() function in the template files reveals the spoiler by removing background and showing text
          return '<table cellpadding="0" cellspacing="0" class="spoiler-box" style="display:inline-table;vertical-align:text-top;border-spacing:0" onclick="show(this);event.stopPropagation();return false">' +
                 '<tr><td style="line-height:1;padding:1px 4px">' +
                 '<span style="visibility:hidden">' + rendered + '</span>' +
                 '</td></tr></table>';
      });

      // Restore Underlines
      str = str.replace(/§§UNDERLINE(\d+)§§/g, function(m, i) {
          const content = underlinePlaceholders[parseInt(i)];
          const rendered = md.renderInline(content);
          return `<u>${rendered}</u>`;
      });
      return str;
  }

  // Restore Nested items
  result = resolveNested(result);

  // Step 5: Restore Blocks

  // Restore Headers
  result = result.replace(/§§HEADER(\d+)§§/g, function(m, i) {
    const h = headerPlaceholders[parseInt(i)];
    const content = resolveNested(md.renderInline(h.content));
    return `<h${h.level}>${content}</h${h.level}>`;
  });

  // Restore Subtext
  result = result.replace(/§§SUBTEXT(\d+)§§/g, function(m, i) {
    const content = resolveNested(md.renderInline(subtextPlaceholders[parseInt(i)]));
    return `<small class="subtext">${content}</small>`;
  });

  // Restore Blockquotes
  result = result.replace(/§§BLOCKQUOTE(\d+)§§/g, function(m, i) {
      const lines = blockQuotePlaceholders[parseInt(i)];
      const processed = lines.map(l => {
          if (!l || l.trim() === '') return '\u00A0'; // Preserve empty lines
          return resolveNested(md.renderInline(l));
      }).join('<br>');
      
      return `<div class="blockquote-container"><div class="blockquote-bar"></div><blockquote class="discord-quote">${processed}</blockquote></div>`;
  });

  // Restore Lists
  result = result.replace(/§§BULLETLIST(\d+)§§/g, function(m, i) {
    const items = bulletListPlaceholders[parseInt(i)];
    let html = '';
    let currentLevel = 0;
    let openTags = 1; 

    html += '<ul>';

    items.forEach(item => {
        const itemLevel = Math.floor(item.indent / 2);

        if (itemLevel > currentLevel) {
            const diff = itemLevel - currentLevel;
            for(let k=0; k < diff; k++) {
                html += '<ul>';
                openTags++;
            }
        } else if (itemLevel < currentLevel) {
            const diff = currentLevel - itemLevel;
            for(let k=0; k < diff; k++) {
                html += '</ul>';
                openTags--;
            }
        }
        currentLevel = itemLevel;

        let content = item.content;
        let processedContent = resolveNested(md.renderInline(content));
        html += `<li>${processedContent}</li>`;
    });

    while (openTags > 0) {
        html += '</ul>';
        openTags--;
    }

    return html;
  });

  // Restore Code
  result = result.replace(/§§CODEINLINE(\d+)§§/g, (m, i) => {
      return `<code>${escapeHtml(codePlaceholders[parseInt(i)].content)}</code>`;
  });
  
  result = result.replace(/§§CODEBLOCK(\d+)§§/g, (m, i) => {
      const item = codePlaceholders[parseInt(i)];
      const lang = item.lang || '';
      const highlightedCode = highlightCode(item.content, lang);
      const langClass = lang ? ` class="language-${lang}"` : '';
      return `<pre><code${langClass}>${highlightedCode}</code></pre>`;
  });

  return result;
}

module.exports = { renderDiscordMarkdown };
