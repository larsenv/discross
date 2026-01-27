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

var md = require('markdown-it')({
  breaks: true,
  linkify: true,
  html: true  // Allow HTML for headers
});

// Custom renderer for emphasis to handle Discord's underline syntax
function renderDiscordMarkdown(text) {
  if (!text) return '';
  
  // Strategy: Process in order - code blocks first (protect them),
  // then handle Discord-specific markdown, then let markdown-it process the rest
  
  const codePlaceholders = [];
  const underlinePlaceholders = [];
  const headerPlaceholders = [];
  
  // Step 0: Protect code blocks (backticks) from all processing
  text = text.replace(/`([^`]+)`/g, function(match, content) {
    const index = codePlaceholders.length;
    codePlaceholders.push(content);
    return `§§CODE${index}§§`;
  });
  
  // Step 1: Protect triple underscores (bold italic) - convert to ***
  text = text.replace(/___(.+?)___/g, '***$1***');
  
  // Step 2: Protect double underscores (underline) with placeholders
  // This prevents markdown-it from treating __ as bold
  text = text.replace(/__([^_]+?)__/g, function(match, content) {
    const index = underlinePlaceholders.length;
    underlinePlaceholders.push(content);
    return `§§UNDERLINE${index}§§`;
  });
  
  // Step 3: Process headers at the start of lines (BEFORE markdown-it processing)
  // We need to capture the content with placeholders intact
  const originalText = text;
  text = text.replace(/^(#{1,3})\s+(.+)$/gm, function(match, hashes, content) {
    const level = hashes.length;
    const index = headerPlaceholders.length;
    // Store content with placeholders - we'll process it in step 6
    headerPlaceholders.push({ level, content });
    return `§§HEADER${index}§§`;
  });
  
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
    
    // Replace underline placeholders in header content
    headerContent = headerContent.replace(/§§UNDERLINE(\d+)§§/g, function(m, i) {
      const content = underlinePlaceholders[parseInt(i)];
      const renderedContent = md.renderInline(content);
      return `<u>${renderedContent}</u>`;
    });
    
    // Process rest of markdown in header
    const renderedContent = md.renderInline(headerContent);
    return `<h${header.level}>${renderedContent}</h${header.level}>`;
  });
  
  // Step 7: Restore code blocks
  result = result.replace(/§§CODE(\d+)§§/g, function(match, index) {
    const content = codePlaceholders[parseInt(index)];
    // HTML escape the content
    const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<code>${escaped}</code>`;
  });
  
  return result;
}

module.exports = { renderDiscordMarkdown };
