var md = require('markdown-it')({
  breaks: true,
  linkify: true,
  html: false
});

// Helper to safely escape HTML manually for code blocks
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

  // Step 0: Protect Code Blocks (Triple Backticks)
  // UPDATED: Regex now consumes the newline following the backticks (with or without a language)
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

  // Step 2: Protect Spoilers (||text||) - Non-greedy match
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
        bulletListPlaceholders.push(currentList.slice());
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

    // 3.5: Bullet Lists (* or -)
    const listMatch = line.match(/^\s*[-*]\s+(.*)$/);
    if (listMatch) {
      currentList.push(listMatch[1]);
      inList = true;
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
      str = str.replace(/§§SPOILER(\d+)§§/g, function(m, i) {
          const content = spoilerPlaceholders[parseInt(i)];
          const rendered = md.renderInline(content); 
          return `<span class="spoiler" onclick="this.classList.toggle('revealed')">${rendered}</span>`;
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

  // Restore Lists
  result = result.replace(/§§BULLETLIST(\d+)§§/g, function(m, i) {
    const items = bulletListPlaceholders[parseInt(i)];
    const listItems = items.map(item => `<li>${resolveNested(md.renderInline(item))}</li>`).join('');
    return `<ul>${listItems}</ul>`;
  });

  // Restore Code (inlineblock) - MUST be last to avoid escaping html tags we just added
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
