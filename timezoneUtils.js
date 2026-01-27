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
  
  // Fallback to connection remote address
  return req.connection?.remoteAddress || req.socket?.remoteAddress || '127.0.0.1';
}

/**
 * Get timezone from IP address
 * @param {string} ip - IP address
 * @returns {string|null} - Timezone (e.g., 'America/New_York') or null if not found
 */
function getTimezoneFromIP(ip) {
  // Handle localhost and private IPs - default to UTC
  if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
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
