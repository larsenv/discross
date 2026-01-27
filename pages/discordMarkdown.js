var md = require('markdown-it')({
  breaks: true,
  linkify: true,
  html: false
});

// Helper to safely escape HTML manually
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
  const bulletListPlaceholders = []; // Now stores objects: { indent: number, content: string }
  const blockQuotePlaceholders = [];
  const subtextPlaceholders = [];

  // Step 0: Protect Code Blocks (Triple Backticks)
  // Consumes the first newline after backticks
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

  // Step 2: Protect Spoilers (||text||)
  text = text.replace(/\|\|([\s\S]+?)\|\|/g, function(match, content) {
    const index = spoilerPlaceholders.length;
    spoilerPlaceholders.push(content);
    return `§§SPOILER${index}§§`;
  });

  // Step 3: Line-by-Line Processing
  const lines = text.split('\n');
  const processedLines = [];
  
  let inList = false;
  let currentList = [];
  
  let inMultiLineQuote = false;
  let multiLineQuoteContent = [];

  function finishList() {
      if (currentList.length > 0) {
        const listIndex = bulletListPlaceholders.length;
        bulletListPlaceholders.push(currentList.slice()); // Copy the array
        processedLines.push(`§§BULLETLIST${listIndex}§§`);
        currentList = [];
      }
      inList = false;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 3.1: Multi-line Block Quote (>>>)
    if (inMultiLineQuote) {
        multiLineQuoteContent.push(line);
        continue;
    }
    if (line.startsWith('>>>')) {
        const content = line.substring(3).trim(); 
        inMultiLineQuote = true;
        if (content) multiLineQuoteContent.push(content);
        continue;
    }

    // 3.2: Single-line Block Quote (>)
    if (line.match(/^>\s?.*$/)) {
        finishList(); 
        const content = line.replace(/^>\s?/, '');
        const index = blockQuotePlaceholders.length;
        blockQuotePlaceholders.push([content]);
        processedLines.push(`§§BLOCKQUOTE${index}§§`);
        continue;
    }

    // 3.3: Headers (# Header)
    const headerMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headerMatch) {
        finishList();
        const level = headerMatch[1].length;
        const content = headerMatch[2];
        const index = headerPlaceholders.length;
        headerPlaceholders.push({ level, content });
        processedLines.push(`§§HEADER${index}§§`);
        continue;
    }

    // 3.4: Subtext (-# text)
    const subtextMatch = line.match(/^-#\s+(.+)$/);
    if (subtextMatch) {
        finishList();
        const content = subtextMatch[1];
        const index = subtextPlaceholders.length;
        subtextPlaceholders.push(content);
        processedLines.push(`§§SUBTEXT${index}§§`);
        continue;
    }

    // 3.5: Bullet Lists (* or -) with Indentation Support
    // Captures (spaces)(bullet)(content)
    const listMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (listMatch) {
      inList = true;
      // Store object with indent length and content
      currentList.push({ 
          indent: listMatch[1].length, 
          content: listMatch[3] 
      });
    } else {
      finishList();
      processedLines.push(line);
    }
  }

  if (inList) finishList();
  if (inMultiLineQuote) {
      const index = blockQuotePlaceholders.length;
      blockQuotePlaceholders.push(multiLineQuoteContent);
      processedLines.push(`§§BLOCKQUOTE${index}§§`);
  }
  
  text = processedLines.join('\n');

  // Step 4: Markdown Render (escapes HTML automatically)
  let result = md.renderInline(text);

  // Helper to resolve nested formatting inside placeholders
  function resolveNested(str) {
      // Restore Spoilers
      // FIXED: Added event.stopPropagation() to prevent reply trigger
      // FIXED: Used classList.add to prevent toggling off
      str = str.replace(/§§SPOILER(\d+)§§/g, function(m, i) {
          const content = spoilerPlaceholders[parseInt(i)];
          const rendered = md.renderInline(content); 
          return `<span class="spoiler" onclick="event.stopPropagation(); this.classList.add('revealed');">${rendered}</span>`;
      });

      // Restore Underlines
      str = str.replace(/§§UNDERLINE(\d+)§§/g, function(m, i) {
          const content = underlinePlaceholders[parseInt(i)];
          const rendered = md.renderInline(content);
          return `<u>${rendered}</u>`;
      });
      return str;
  }

  // Restore Nested items in the main text first
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
      const processed = lines.map(l => resolveNested(md.renderInline(l))).join('<br>');
      return `<div class="blockquote-container"><div class="blockquote-bar"></div><blockquote class="discord-quote">${processed}</blockquote></div>`;
  });

  // Restore Lists (With Nesting and Headers)
  result = result.replace(/§§BULLETLIST(\d+)§§/g, function(m, i) {
    const items = bulletListPlaceholders[parseInt(i)];
    let html = '';
    let currentLevel = 0; // The conceptual indentation level
    let openTags = 1; // We start with one <ul> implicit from the loop

    html += '<ul>';

    items.forEach(item => {
        // Calculate indentation level (2 spaces = 1 level, but allow 1 space grace)
        const itemLevel = Math.floor(item.indent / 2);

        // Adjust open tags to match level
        if (itemLevel > currentLevel) {
            // Needed to go deeper: open ULs
            const diff = itemLevel - currentLevel;
            for(let k=0; k < diff; k++) {
                html += '<ul>';
                openTags++;
            }
        } else if (itemLevel < currentLevel) {
            // Needed to go shallower: close ULs
            const diff = currentLevel - itemLevel;
            for(let k=0; k < diff; k++) {
                html += '</ul>';
                openTags--;
            }
        }
        currentLevel = itemLevel;

        // Process Content (Check for Headers inside List Items)
        let content = item.content;
        const headerMatch = content.match(/^(#{1,3})\s+(.+)$/);
        
        let processedContent = '';
        if (headerMatch) {
             const hLevel = headerMatch[1].length;
             const hText = headerMatch[2];
             processedContent = `<h${hLevel}>${resolveNested(md.renderInline(hText))}</h${hLevel}>`;
        } else {
             processedContent = resolveNested(md.renderInline(content));
        }

        html += `<li>${processedContent}</li>`;
    });

    // Close any remaining open tags
    while (openTags > 0) {
        html += '</ul>';
        openTags--;
    }

    return html;
  });

  // Restore Code (Inline & Block) - MUST be last
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
