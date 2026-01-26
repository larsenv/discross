const fs = require('fs');
const path = require('path');

// Cache directory path
const CACHE_DIR = path.join(__dirname, 'static', 'emoji_cache');

/**
 * Get cache statistics
 * @returns {object} Object with count and total size in bytes
 */
function getCacheStats() {
  if (!fs.existsSync(CACHE_DIR)) {
    return { count: 0, totalSize: 0, totalSizeMB: '0.00' };
  }
  
  const files = fs.readdirSync(CACHE_DIR);
  let totalSize = 0;
  let fileCount = 0;
  
  for (const file of files) {
    const filePath = path.join(CACHE_DIR, file);
    const stats = fs.statSync(filePath);
    if (stats.isFile()) {
      fileCount++;
      totalSize += stats.size;
    }
  }
  
  return {
    count: fileCount,
    totalSize: totalSize,
    totalSizeMB: totalSize > 0 ? (totalSize / 1024 / 1024).toFixed(2) : '0.00'
  };
}

/**
 * Clear emojis older than specified age
 * @param {number} maxAgeMs - Maximum age in milliseconds
 * @returns {object} Object with count of removed files
 */
function clearOldCache(maxAgeMs) {
  if (!fs.existsSync(CACHE_DIR)) {
    return { removed: 0 };
  }
  
  const now = Date.now();
  const files = fs.readdirSync(CACHE_DIR);
  let removed = 0;
  
  for (const file of files) {
    const filePath = path.join(CACHE_DIR, file);
    const stats = fs.statSync(filePath);
    
    if (stats.isFile() && (now - stats.mtimeMs) > maxAgeMs) {
      fs.unlinkSync(filePath);
      removed++;
    }
  }
  
  return { removed };
}

/**
 * Clear entire cache
 * @returns {object} Object with count of removed files
 */
function clearAllCache() {
  if (!fs.existsSync(CACHE_DIR)) {
    return { removed: 0 };
  }
  
  const files = fs.readdirSync(CACHE_DIR);
  let removed = 0;
  
  for (const file of files) {
    const filePath = path.join(CACHE_DIR, file);
    const stats = fs.statSync(filePath);
    
    if (stats.isFile()) {
      fs.unlinkSync(filePath);
      removed++;
    }
  }
  
  return { removed };
}

module.exports = {
  getCacheStats,
  clearOldCache,
  clearAllCache
};
