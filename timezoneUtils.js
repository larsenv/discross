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
 * Format a date with timezone - Discord style
 * @param {Date} date - Date object to format
 * @param {string|null} timezone - Timezone string (e.g., 'America/New_York') or null for default
 * @returns {string} - Formatted date string (e.g., "Today at 12:30PM", "Yesterday at 3:45AM", "01/15/26, 9:00PM")
 */
function formatDateWithTimezone(date, timezone) {
  try {
    const userTimezone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    
    // Get current date/time
    const now = new Date();
    
    // Extract date components in the target timezone for both dates
    const getDateComponents = (d) => {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: userTimezone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric'
      });
      const parts = formatter.formatToParts(d);
      const year = parseInt(parts.find(p => p.type === 'year').value);
      const month = parseInt(parts.find(p => p.type === 'month').value) - 1; // 0-indexed
      const day = parseInt(parts.find(p => p.type === 'day').value);
      return { year, month, day };
    };
    
    const messageComps = getDateComponents(date);
    const todayComps = getDateComponents(now);
    
    // Create date-only objects in UTC for comparison
    const messageDateOnly = Date.UTC(messageComps.year, messageComps.month, messageComps.day);
    const todayDateOnly = Date.UTC(todayComps.year, todayComps.month, todayComps.day);
    
    // Calculate difference in days
    const diffTime = todayDateOnly - messageDateOnly;
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
    
    // Format time part (e.g., "12:30PM")
    const timeOptions = {
      timeZone: userTimezone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    };
    const timeStr = date.toLocaleString('en-US', timeOptions);
    
    if (diffDays === 0) {
      // Today
      return `Today at ${timeStr}`;
    } else if (diffDays === 1) {
      // Yesterday
      return `Yesterday at ${timeStr}`;
    } else {
      // 2+ days ago - use locale-aware date format
      const dateOptions = {
        timeZone: userTimezone,
        month: '2-digit',
        day: '2-digit',
        year: '2-digit'
      };
      const dateStr = date.toLocaleString('en-US', dateOptions);
      return `${dateStr}, ${timeStr}`;
    }
  } catch (err) {
    // If timezone is invalid, fall back to default format
    console.error('Error formatting date with timezone:', err);
    return date.toLocaleTimeString('en-US') + " " + date.toDateString();
  }
}

/**
 * Format a date separator for display between different days
 * @param {Date} date - Date object to format
 * @param {string|null} timezone - Timezone string (e.g., 'America/New_York') or null for default
 * @returns {string} - Formatted date separator string (e.g., "January 25, 2026")
 */
function formatDateSeparator(date, timezone) {
  try {
    const userTimezone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    
    const options = {
      timeZone: userTimezone,
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    };
    
    return date.toLocaleString('en-US', options);
  } catch (err) {
    console.error('Error formatting date separator:', err);
    return date.toDateString();
  }
}

/**
 * Check if two dates are on different days in the given timezone
 * @param {Date} date1 - First date
 * @param {Date} date2 - Second date or null (if null, always returns true)
 * @param {string|null} timezone - Timezone string or null for default
 * @returns {boolean} - True if dates are on different days (or date2 is null)
 */
function areDifferentDays(date1, date2, timezone) {
  if (!date2) {
    return true; // First message, always show separator
  }
  
  try {
    const userTimezone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    
    // Extract date components for both dates
    const getDateComponents = (d) => {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: userTimezone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric'
      });
      const parts = formatter.formatToParts(d);
      const year = parseInt(parts.find(p => p.type === 'year').value);
      const month = parseInt(parts.find(p => p.type === 'month').value);
      const day = parseInt(parts.find(p => p.type === 'day').value);
      return `${year}-${month}-${day}`;
    };
    
    return getDateComponents(date1) !== getDateComponents(date2);
  } catch (err) {
    console.error('Error comparing dates:', err);
    return false;
  }
}

module.exports = {
  getClientIP,
  getTimezoneFromIP,
  formatDateWithTimezone,
  formatDateSeparator,
  areDifferentDays
};
