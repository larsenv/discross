var md = require('markdown-it')({
  breaks: true,
  linkify: true,
  html: false
});

function renderDiscordMarkdown(text) {
  if (!text) return '';

  const codePlaceholders = [];
  const underlinePlaceholders = [];
  const spoilerPlaceholders = [];
  const headerPlaceholders = [];
  const bulletListPlaceholders = [];
  const blockQuotePlaceholders = [];

  // Step 0: Protect Code Blocks (Match triple backticks first!)
  // Discord supports optional language definitions after the first backticks (e.g. ```js)
  text = text.replace(/```(?:(\w+)\n)?([\s\S]*?)```/g, function(match, lang, content) {
    const index = codePlaceholders.length;
    // content might be undefined if empty, preserve raw formatting including newlines
    codePlaceholders.push({ type: 'block', content: content || '', lang: lang || '' });
    return `§§CODEBLOCK${index}§§`;
  });

  // Step 0.5: Protect Inline Code
  text = text.replace(/`([^`]*)`/g, function(match, content) {
    const index = codePlaceholders.length;
    codePlaceholders.push({ type: 'inline', content: content });
    return `§§CODEINLINE${index}§§`;
  });

  // Step 1: Protect triple underscores (bold italic)
  text = text.replace(/___(.+?)___/g, '***$1***');

  // Step 2: Protect double underscores (underline)
  text = text.replace(/__(.+?)__/g, function(match, content) {
    const index = underlinePlaceholders.length;
    underlinePlaceholders.push(content);
    return `§§UNDERLINE${index}§§`;
  });

  // Step 2.5: Protect Spoilers (||text||)
  text = text.replace(/\|\|(.+?)\|\|/g, function(match, content) {
    const index = spoilerPlaceholders.length;
    spoilerPlaceholders.push(content);
    return `§§SPOILER${index}§§`;
  });

  // Step 3: Process headers
  const originalText = text;
  text = text.replace(/^(#{1,3})\s*(.+)$/gm, function(match, hashes, content) {
    const level = hashes.length;
    const index = headerPlaceholders.length;
    headerPlaceholders.push({ level, content });
    return `§§HEADER${index}§§`;
  });

  // Step 3.5: Process Block Quotes and Lists
  // We process line by line to handle > and - 
  const lines = text.split('\n');
  const processedLines = [];
  
  let inList = false;
  let currentList = [];
  
  // Discord treats >>> as a multi-line quote that consumes the rest of the message
  let inMultiLineQuote = false;
  let multiLineQuoteContent = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Priority 1: Multi-line Block Quote (>>>)
    // If we hit >>>, everything else is part of the quote until the string ends.
    if (inMultiLineQuote) {
        multiLineQuoteContent.push(line);
        continue; // Skip other processing for this line
    }
    if (line.startsWith('>>>')) {
        const content = line.substring(3).trim();
        inMultiLineQuote = true;
        if (content) multiLineQuoteContent.push(content);
        continue;
    }

    // Priority 2: Single-line Block Quote (>)
    if (line.startsWith('> ')) {
        const content = line.substring(2);
        // We render these immediately as individual blockquotes (Discord behavior)
        // or you could group them. Here we use a placeholder.
        const index = blockQuotePlaceholders.length;
        blockQuotePlaceholders.push([content]);
        processedLines.push(`§§BLOCKQUOTE${index}§§`);
        
        // Reset list if we were in one
        if (inList) {
            finishList();
        }
        continue;
    }

    // Priority 3: Bullet Lists
    const listMatch = line.match(/^-\s+(.*)$/);
    if (listMatch) {
      currentList.push(listMatch[1]);
      inList = true;
    } else {
      // Not a list item
      if (inList) {
        finishList();
      }
      processedLines.push(line);
    }
  }

  // Helper to close lists
  function finishList() {
      if (currentList.length > 0) {
        const listIndex = bulletListPlaceholders.length;
        bulletListPlaceholders.push(currentList.slice());
        processedLines.push(`§§BULLETLIST${listIndex}§§`);
        currentList = [];
      }
      inList = false;
  }

  // Handle remaining list
  if (inList) finishList();

  // Handle remaining multi-line quote
  if (inMultiLineQuote) {
      const index = blockQuotePlaceholders.length;
      blockQuotePlaceholders.push(multiLineQuoteContent);
      processedLines.push(`§§BLOCKQUOTE${index}§§`);
  }
  
  text = processedLines.join('\n');

  // Step 4: Markdown-it rendering
  let result = md.renderInline(text);

  // Helper function to process nested formatting (Underline & Spoiler)
  // We need this because headers/lists/quotes might contain placeholders
  function resolveNestedFormatting(str) {
      // Restore Spoilers
      str = str.replace(/§§SPOILER(\d+)§§/g, function(m, i) {
          const content = spoilerPlaceholders[parseInt(i)];
          // Recurse for nested formatting inside spoiler
          const rendered = md.renderInline(content); 
          // Note: Spoilers usually need a click handler in CSS/JS, here we just use a class
          return `<span class="spoiler" onclick="this.classList.add('revealed')">${rendered}</span>`;
      });

      // Restore Underlines
      str = str.replace(/§§UNDERLINE(\d+)§§/g, function(m, i) {
          const content = underlinePlaceholders[parseInt(i)];
          const rendered = md.renderInline(content);
          return `<u>${rendered}</u>`;
      });

      return str;
  }

  // Step 5: Restore Underlines & Spoilers in the main text
  // (We actually need to do this carefully inside blocks too, so we'll do it in the restoration steps)
  result = resolveNestedFormatting(result);

  // Step 6: Restore Headers
  result = result.replace(/§§HEADER(\d+)§§/g, function(match, index) {
    const header = headerPlaceholders[parseInt(index)];
    let content = header.content;
    
    // Render markdown and resolve nested placeholders
    content = md.renderInline(content);
    content = resolveNestedFormatting(content);
    
    return `<h${header.level}>${content}</h${header.level}>`;
  });

  // Step 7: Restore Block Quotes
  result = result.replace(/§§BLOCKQUOTE(\d+)§§/g, function(match, index) {
      const lines = blockQuotePlaceholders[parseInt(index)];
      // Process each line in the blockquote
      const processedLines = lines.map(line => {
          let content = md.renderInline(line);
          return resolveNestedFormatting(content);
      }).join('<br>'); // Join multiline quotes with breaks
      
      return `<blockquote style="border-left: 4px solid #ccc; padding-left: 10px; margin-left:0;">${processedLines}</blockquote>`;
  });

  // Step 8: Restore Bullet Lists
  result = result.replace(/§§BULLETLIST(\d+)§§/g, function(match, index) {
    const items = bulletListPlaceholders[parseInt(index)];
    const listItems = items.map(item => {
      let content = md.renderInline(item);
      content = resolveNestedFormatting(content);
      return `<li>${content}</li>`;
    }).join('');
    return `<ul>${listItems}</ul>`;
  });

  // Step 9: Restore Code Blocks (Inline and Block)
  // Restore Inline
  result = result.replace(/§§CODEINLINE(\d+)§§/g, function(match, index) {
    const item = codePlaceholders[parseInt(index)];
    const escaped = item.content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<code>${escaped}</code>`;
  });
  
  // Restore Blocks
  result = result.replace(/§§CODEBLOCK(\d+)§§/g, function(match, index) {
    const item = codePlaceholders[parseInt(index)];
    const escaped = item.content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // If language exists, add it as a class (standard highlight.js format)
    const langClass = item.lang ? ` class="language-${item.lang}"` : '';
    return `<pre><code${langClass}>${escaped}</code></pre>`;
  });

  return result;
}

module.exports = { renderDiscordMarkdown };
