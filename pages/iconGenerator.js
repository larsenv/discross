'use strict';
const sharp = require('sharp');
const { normalizeWeirdUnicode } = require('./unicodeUtils');

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

    // Normalize weird Unicode characters (e.g. mathematical styled letters) before processing
    serverName = normalizeWeirdUnicode(serverName);

    // Split by spaces to get words
    const words = serverName.trim().split(/\s+/);

    if (words.length === 1) {
        // Single word: take first character
        return words[0].charAt(0);
    }

    // Multiple words: take first character of each word with its surrounding punctuation
    return words
        .map((word) => {
            // Find the first Unicode letter (covers Latin, CJK, Arabic, etc.)
            const firstLetterMatch = word.match(/\p{L}/u);
            if (!firstLetterMatch) {
                // No letter found, return first character
                return word.charAt(0);
            }

            const firstLetterIndex = firstLetterMatch.index;
            const firstLetter = word.charAt(firstLetterIndex);

            // Get any punctuation that comes before the first letter
            const prefixPunctuation = word.slice(0, firstLetterIndex);

            // Skip all letters and digits after the first letter, then collect punctuation
            const afterFirst = word.slice(firstLetterIndex + 1);
            const suffixPunctuation = afterFirst.replace(/^[a-zA-Z0-9]+/, '');

            return prefixPunctuation + firstLetter + suffixPunctuation;
        })
        .join('');
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
    const ICON_THEME_COLORS = {
        light: { bgColor: '#f0f0f0', textColor: '#333333' },
        amoled: { bgColor: '#000000', textColor: '#ffffff' },
    };
    const { bgColor, textColor } = ICON_THEME_COLORS[theme] ?? {
        bgColor: '#2c2f33',
        textColor: '#ffffff',
    };

    // Calculate font size based on acronym length (shorter acronyms get bigger font)
    // Lengths 4 and 5 both map to 32px (same tier in the original if/else)
    const FONT_SIZES = [64, 48, 40, 32, 32];
    const fontSize = FONT_SIZES[acronym.length - 1] ?? 24;

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
    const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();

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
    const gifBuffer = await sharp(pngBuffer).gif().toBuffer();

    return gifBuffer;
}

module.exports = {
    generateAcronym,
    generatePlaceholderIcon,
    generatePlaceholderIconAsGif,
};
