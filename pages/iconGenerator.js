const sharp = require('sharp');

/**
 * Generate an acronym from a server name, preserving case and punctuation
 * Examples:
 * - "GameTV" -> "G"
 * - "Game T V" -> "GTV"
 * - "Game T v" -> "GTv"
 * - "Game T... V..." -> "GT...V..."
 * - "Game() T.. V!" -> "G()T..V!"
 */
function generateAcronym(serverName) {
  if (!serverName || serverName.trim().length === 0) {
    return '?';
  }

  // Split by spaces to get words
  const words = serverName.trim().split(/\s+/);
  
  if (words.length === 1) {
    // Single word: take first character
    return words[0].charAt(0);
  }
  
  // Multiple words: take first character of each word with its surrounding punctuation
  return words.map(word => {
    // Find the first letter
    const firstLetterMatch = word.match(/[a-zA-Z]/);
    if (!firstLetterMatch) {
      // No letter found, return first character
      return word.charAt(0);
    }
    
    const firstLetterIndex = firstLetterMatch.index;
    const firstLetter = word.charAt(firstLetterIndex);
    
    // Get any punctuation that comes before the first letter
    let prefixPunctuation = '';
    for (let i = 0; i < firstLetterIndex; i++) {
      prefixPunctuation += word.charAt(i);
    }
    
    // Skip all letters and digits after the first letter, then collect punctuation
    let suffixPunctuation = '';
    let i = firstLetterIndex + 1;
    // Skip remaining alphanumeric characters
    while (i < word.length && /[a-zA-Z0-9]/.test(word.charAt(i))) {
      i++;
    }
    // Collect all remaining characters (punctuation)
    while (i < word.length) {
      suffixPunctuation += word.charAt(i);
      i++;
    }
    
    return prefixPunctuation + firstLetter + suffixPunctuation;
  }).join('');
}

/**
 * Generate a placeholder icon with the server's acronym
 * @param {string} serverName - The name of the server
 * @param {string} theme - Theme: 'dark' (default), 'light', or 'amoled'
 * @returns {Promise<Buffer>} - PNG buffer of the generated icon
 */
async function generatePlaceholderIcon(serverName, theme = 'dark') {
  const acronym = generateAcronym(serverName);
  const size = 128;
  
  // Determine background and text colors based on theme
  let bgColor, textColor;
  if (theme === 'light') {
    bgColor = '#f0f0f0'; // Light gray background
    textColor = '#333333'; // Dark text
  } else if (theme === 'amoled') {
    bgColor = '#000000'; // Pure black background
    textColor = '#ffffff'; // White text
  } else {
    // Default dark theme
    bgColor = '#2c2f33'; // Discord-like dark gray
    textColor = '#ffffff'; // White text
  }
  
  // Calculate font size based on acronym length
  // Shorter acronyms get bigger font, longer ones get smaller
  let fontSize;
  if (acronym.length === 1) {
    fontSize = 64;
  } else if (acronym.length === 2) {
    fontSize = 48;
  } else if (acronym.length === 3) {
    fontSize = 40;
  } else if (acronym.length <= 5) {
    fontSize = 32;
  } else {
    fontSize = 24;
  }
  
  // Create SVG with text
  const svg = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${size}" height="${size}" fill="${bgColor}" rx="24" ry="24"/>
      <text 
        x="50%" 
        y="50%" 
        font-family="Arial, Helvetica, sans-serif" 
        font-size="${fontSize}" 
        fill="${textColor}" 
        text-anchor="middle" 
        dominant-baseline="central"
      >${acronym}</text>
    </svg>
  `;
  
  // Convert SVG to PNG using sharp
  const pngBuffer = await sharp(Buffer.from(svg))
    .png()
    .toBuffer();
  
  return pngBuffer;
}

/**
 * Generate a placeholder icon and convert it to GIF format
 * @param {string} serverName - The name of the server
 * @param {string} theme - Theme: 'dark' (default), 'light', or 'amoled'
 * @returns {Promise<Buffer>} - GIF buffer of the generated icon
 */
async function generatePlaceholderIconAsGif(serverName, theme = 'dark') {
  const pngBuffer = await generatePlaceholderIcon(serverName, theme);
  
  // Convert PNG to GIF
  const gifBuffer = await sharp(pngBuffer)
    .gif()
    .toBuffer();
  
  return gifBuffer;
}

module.exports = {
  generateAcronym,
  generatePlaceholderIcon,
  generatePlaceholderIconAsGif
};
