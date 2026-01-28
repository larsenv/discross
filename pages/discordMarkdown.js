var md = require('markdown-it')({
  breaks: true,
  linkify: true,
  html: false
});

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderDiscordMarkdown(text) {
  if (!text) return '';

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
    codePlaceholders.push({ type: 'block', content: content || '', lang: lang || '' });
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
      // Restore Spoilers
      // FIXED: Added event.preventDefault() and stopPropagation() on both click and mousedown
      // to ensure no parent events (like Quote/Reply) are triggered.
      str = str.replace(/§§SPOILER(\d+)§§/g, function(m, i) {
          const content = spoilerPlaceholders[parseInt(i)];
          const rendered = md.renderInline(content); 
          return `<span class="spoiler" onclick="event.preventDefault(); event.stopPropagation(); this.classList.add('revealed'); return false;" onmousedown="event.preventDefault(); event.stopPropagation();">${rendered}</span>`;
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
      const lang = item.lang ? ` class="language-${item.lang}"` : '';
      return `<pre><code${lang}>${escapeHtml(item.content)}</code></pre>`;
  });

  return result;
}

module.exports = { renderDiscordMarkdown };
