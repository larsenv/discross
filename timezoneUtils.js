const geoip = require('geoip-lite');

/**
 * Get client's IP address from request, handling proxies
 * @param {Object} req - HTTP request object
 * @returns {string} - Client IP address
 */
function getClientIP(req) {
  // Check for common proxy headers
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // x-forwarded-for can contain multiple IPs, the first one is the client
    return forwarded.split(',')[0].trim();
  }
  
  const realIP = req.headers['x-real-ip'];
  if (realIP) {
    return realIP;
  }
  
  // Fallback to socket remote address
  return req.socket?.remoteAddress || '127.0.0.1';
}

/**
 * Check if an IP address is private/local
 * @param {string} ip - IP address
 * @returns {boolean} - True if private/local, false otherwise
 */
function isPrivateIP(ip) {
  // IPv4 localhost
  if (ip === '127.0.0.1') return true;
  
  // IPv6 localhost
  if (ip === '::1') return true;
  
  // IPv4 private ranges
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('10.')) return true;
  
  // IPv4 172.16.0.0/12 range (172.16.x.x to 172.31.x.x)
  const parts = ip.split('.');
  if (parts.length === 4 && parts[0] === '172') {
    const second = parseInt(parts[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  
  // IPv6 private ranges
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // fc00::/7
  if (ip.startsWith('fe80:')) return true; // fe80::/10
  
  return false;
}

/**
 * Get timezone from IP address
 * @param {string} ip - IP address
 * @returns {string|null} - Timezone (e.g., 'America/New_York') or null if not found
 */
function getTimezoneFromIP(ip) {
  // Handle localhost and private IPs - default to UTC
  if (isPrivateIP(ip)) {
    return null; // Will use default behavior
  }
  
  const geo = geoip.lookup(ip);
  if (geo && geo.timezone) {
    return geo.timezone;
  }
  
  return null;
}

/**
 * Format a date with timezone
 * @param {Date} date - Date object to format
 * @param {string|null} timezone - Timezone string (e.g., 'America/New_York') or null for default
 * @returns {string} - Formatted date string
 */
function formatDateWithTimezone(date, timezone) {
  try {
    if (!timezone) {
      // Fallback to original format if no timezone
      return date.toLocaleTimeString('en-US') + " " + date.toDateString();
    }
    
    // Format with timezone
    const options = {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    };
    
    return date.toLocaleString('en-US', options);
  } catch (err) {
    // If timezone is invalid, fall back to default format
    console.error('Error formatting date with timezone:', err);
    return date.toLocaleTimeString('en-US') + " " + date.toDateString();
  }
}

module.exports = {
  getClientIP,
  getTimezoneFromIP,
  formatDateWithTimezone
};
