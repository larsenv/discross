// Discord-specific markdown utilities
// Discord uses non-standard markdown syntax:
// - __text__ is underline (not bold like standard markdown)
// - **text** is bold
// - *text* is italic  
// - ***text*** is bold italic
// - ~~text~~ is strikethrough
// - _text_ is italic (single underscore, like standard markdown)
// - ___text___ is bold italic with underscores

var md = require('markdown-it')({
  breaks: true,
  linkify: true,
  html: true  // Allow HTML so our <u> tags pass through
});

// Custom renderer for emphasis to handle Discord's underline syntax
function renderDiscordMarkdown(text) {
  if (!text) return '';
  
  // Strategy: Replace Discord-specific markdown with HTML before markdown-it processing
  // This prevents conflicts with standard markdown rules
  
  // Process in order from longest to shortest to avoid conflicts:
  
  // 1. Handle ___text___ (bold italic with underscores) - convert to ***text***
  text = text.replace(/___([^_]+?)___/g, '***$1***');
  
  // 2. Handle __text__ (Discord underline) - convert to <u>text</u> HTML
  //    Match exactly 2 underscores, not 3 or more
  text = text.replace(/(^|[^_])__([^_](?:(?!__).)*?)__([^_]|$)/g, '$1<u>$2</u>$3');
  
  // Now render with markdown-it (which handles **, *, ***, ~~, etc.)
  return md.renderInline(text);
}

module.exports = { renderDiscordMarkdown };
