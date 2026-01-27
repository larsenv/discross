// Discord-specific markdown utilities
// Discord uses non-standard markdown syntax:
// - __text__ is underline (not bold like standard markdown)
// - **text** is bold
// - *text* is italic  
// - ***text*** is bold italic
// - ~~text~~ is strikethrough
// - _text_ is italic (single underscore, like standard markdown)
// - ___text___ is bold italic with underscores
// - # Header, ## Header, ### Header - headers (only in some contexts)
// - Hyphenated bullet points (- item) converted to HTML bullet lists

var md = require('markdown-it')({
  breaks: true,
  linkify: true,
  html: false  // Don't allow raw HTML for security
});

// Custom renderer for emphasis to handle Discord's underline syntax
function renderDiscordMarkdown(text) {
  if (!text) return '';
  
  // Strategy: Process in order - code blocks first (protect them),
  // then handle Discord-specific markdown, then let markdown-it process the rest
  
  const codePlaceholders = [];
  const underlinePlaceholders = [];
  const headerPlaceholders = [];
  const bulletListPlaceholders = [];
  
  // Step 0: Protect code blocks (backticks) from all processing
  // Handle both inline code with content and empty code blocks
  text = text.replace(/`([^`]*)`/g, function(match, content) {
    const index = codePlaceholders.length;
    codePlaceholders.push(content);
    return `§§CODE${index}§§`;
  });
  
  // Step 1: Protect triple underscores (bold italic) - convert to ***
  text = text.replace(/___(.+?)___/g, '***$1***');
  
  // Step 2: Protect double underscores (underline) with placeholders
  // This prevents markdown-it from treating __ as bold
  // Allow underscores within the content
  text = text.replace(/__(.+?)__/g, function(match, content) {
    const index = underlinePlaceholders.length;
    underlinePlaceholders.push(content);
    return `§§UNDERLINE${index}§§`;
  });
  
  // Step 3: Process headers at the start of lines (BEFORE markdown-it processing)
  // Allow optional whitespace after # for flexibility
  // We need to capture the content with placeholders intact
  const originalText = text;
  text = text.replace(/^(#{1,3})\s*(.+)$/gm, function(match, hashes, content) {
    const level = hashes.length;
    const index = headerPlaceholders.length;
    // Store content with placeholders - we'll process it in step 6
    headerPlaceholders.push({ level, content });
    return `§§HEADER${index}§§`;
  });
  
  // Step 3.5: Process bullet lists (hyphenated items at the start of lines)
  // Convert consecutive lines starting with "- " into HTML bullet lists
  // Split by newlines to process line by line
  const lines = text.split('\n');
  const processedLines = [];
  let inList = false;
  let currentList = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Check if line starts with "- " (bullet point)
    if (/^-\s+(.+)$/.test(line)) {
      const match = line.match(/^-\s+(.+)$/);
      currentList.push(match[1]);
      inList = true;
    } else {
      // Not a bullet point line
      if (inList && currentList.length > 0) {
        // End the current list and add it
        const listIndex = bulletListPlaceholders.length;
        bulletListPlaceholders.push(currentList.slice());
        processedLines.push(`§§BULLETLIST${listIndex}§§`);
        currentList = [];
        inList = false;
      }
      processedLines.push(line);
    }
  }
  
  // Handle any remaining list at the end
  if (inList && currentList.length > 0) {
    const listIndex = bulletListPlaceholders.length;
    bulletListPlaceholders.push(currentList.slice());
    processedLines.push(`§§BULLETLIST${listIndex}§§`);
  }
  
  text = processedLines.join('\n');
  
  // Step 4: Let markdown-it process (handles **, *, ***, ~~, etc.)
  let result = md.renderInline(text);
  
  // Step 5: Restore underlines with proper HTML
  result = result.replace(/§§UNDERLINE(\d+)§§/g, function(match, index) {
    // Recursively process the content to allow nested formatting
    const content = underlinePlaceholders[parseInt(index)];
    // Don't recursively call renderDiscordMarkdown to avoid infinite recursion
    // Instead, just let markdown-it process this content
    const renderedContent = md.renderInline(content);
    return `<u>${renderedContent}</u>`;
  });
  
  // Step 6: Restore headers with proper HTML
  result = result.replace(/§§HEADER(\d+)§§/g, function(match, index) {
    const header = headerPlaceholders[parseInt(index)];
    // Process the header content (which may contain underline placeholders)
    let headerContent = header.content;
    
    // We need to process underlines before markdown-it to avoid escaping
    // Use a different placeholder for processed underlines
    const processedUnderlines = [];
    headerContent = headerContent.replace(/§§UNDERLINE(\d+)§§/g, function(m, i) {
      const content = underlinePlaceholders[parseInt(i)];
      const renderedContent = md.renderInline(content);
      const idx = processedUnderlines.length;
      processedUnderlines.push(`<u>${renderedContent}</u>`);
      return `§§PROCUNDERLINE${idx}§§`;
    });
    
    // Process rest of markdown in header
    let renderedContent = md.renderInline(headerContent);
    
    // Restore the processed underlines (after markdown-it escaping)
    renderedContent = renderedContent.replace(/§§PROCUNDERLINE(\d+)§§/g, function(m, i) {
      return processedUnderlines[parseInt(i)];
    });
    
    return `<h${header.level}>${renderedContent}</h${header.level}>`;
  });
  
  // Step 7: Restore code blocks
  result = result.replace(/§§CODE(\d+)§§/g, function(match, index) {
    const content = codePlaceholders[parseInt(index)];
    // HTML escape the content
    const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<code>${escaped}</code>`;
  });
  
  // Step 8: Restore bullet lists with proper HTML
  result = result.replace(/§§BULLETLIST(\d+)§§/g, function(match, index) {
    const items = bulletListPlaceholders[parseInt(index)];
    const listItems = items.map(item => {
      // Use a similar approach as headers - process underlines with secondary placeholders
      const processedUnderlines = [];
      let processedItem = item.replace(/§§UNDERLINE(\d+)§§/g, function(m, i) {
        const content = underlinePlaceholders[parseInt(i)];
        const renderedContent = md.renderInline(content);
        const idx = processedUnderlines.length;
        processedUnderlines.push(`<u>${renderedContent}</u>`);
        return `§§PROCUNDERLINE${idx}§§`;
      });
      
      // Process rest of markdown
      processedItem = md.renderInline(processedItem);
      
      // Restore the processed underlines
      processedItem = processedItem.replace(/§§PROCUNDERLINE(\d+)§§/g, function(m, i) {
        return processedUnderlines[parseInt(i)];
      });
      
      return `<li>${processedItem}</li>`;
    }).join('');
    return `<ul>${listItems}</ul>`;
  });
  
  return result;
}

module.exports = { renderDiscordMarkdown };
