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
  html: false  // Don't allow raw HTML for security
});

// We need to add a custom inline rule for underline that respects code blocks
md.inline.ruler.before('emphasis', 'discord_underline', function(state, silent) {
  const start = state.pos;
  const marker = state.src.charCodeAt(start);
  
  // Only process __ (two underscores)
  if (marker !== 0x5F /* _ */) { return false; }
  if (state.src.charCodeAt(start + 1) !== 0x5F) { return false; }
  
  // Don't process if it's part of a triple underscore (which becomes bold italic)
  if (state.src.charCodeAt(start + 2) === 0x5F) { return false; }
  if (start > 0 && state.src.charCodeAt(start - 1) === 0x5F) { return false; }
  
  if (silent) { return false; }
  
  // Find the closing __
  let end = start + 2;
  let found = false;
  while (end < state.src.length - 1) {
    if (state.src.charCodeAt(end) === 0x5F && 
        state.src.charCodeAt(end + 1) === 0x5F) {
      // Make sure it's not part of a triple underscore
      if (end + 2 < state.src.length && state.src.charCodeAt(end + 2) === 0x5F) {
        end++;
        continue;
      }
      if (end > 0 && state.src.charCodeAt(end - 1) === 0x5F) {
        end++;
        continue;
      }
      found = true;
      break;
    }
    end++;
  }
  
  if (!found) { return false; }
  
  // Create tokens
  const token_o = state.push('underline_open', 'u', 1);
  token_o.markup = '__';
  
  const token_t = state.push('text', '', 0);
  token_t.content = state.src.slice(start + 2, end);
  
  const token_c = state.push('underline_close', 'u', -1);
  token_c.markup = '__';
  
  state.pos = end + 2;
  return true;
});

// Custom renderer for emphasis to handle Discord's underline syntax
function renderDiscordMarkdown(text) {
  if (!text) return '';
  
  // Convert ___text___ (triple underscore = bold italic) to ***text***
  // This needs to be done before markdown-it processing
  // Allow any content including underscores within the markers
  text = text.replace(/___(.+?)___/g, '***$1***');
  
  return md.renderInline(text);
}

module.exports = { renderDiscordMarkdown };
