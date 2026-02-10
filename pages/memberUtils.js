/**
 * Shared utilities for member data and role color handling
 * This module consolidates member-related functions to ensure consistency
 * across all message rendering pages.
 */

/**
 * Get the display name following Discord's order:
 * server nickname -> Discord global name -> Discord username
 * 
 * @param {Object} member - Discord GuildMember object (may be null)
 * @param {Object} author - Discord User object from message author
 * @returns {string} Display name to show
 */
function getDisplayName(member, author) {
  if (member) {
    // Server nickname (guild nickname) first
    if (member.nickname) {
      return member.nickname;
    }
    // Otherwise Discord global name (from user object)
    if (member.user && member.user.globalName) {
      return member.user.globalName;
    }
    if (member.user && member.user.username) {
      return member.user.username;
    }
    // Fallback to member display name
    return member.displayName;
  }
  
  // For webhooks or when no member data, use author data
  if (author) {
    if (author.globalName) {
      return author.globalName;
    }
    if (author.username) {
      return author.username;
    }
  }
  
  return "Unknown User";
}

/**
 * Get the member's highest role color or default to theme-appropriate color
 * 
 * @param {Object} member - Discord GuildMember object (may be null)
 * @param {string|number} theme - Theme value: 0=dark, 1=light, 2=amoled, or undefined for dark
 * @returns {string} Hex color string (e.g., "#ffffff")
 */
function getMemberColor(member, theme) {
  // Determine default color based on theme
  const getDefaultColor = () => {
    if (theme === 1 || theme === '1') {
      return "#060607"; // Light theme: dark text
    } else if (theme === 2 || theme === '2') {
      return "#ffffff"; // AMOLED theme: white text
    } else {
      return "#dddddd"; // Dark theme (default): light gray text
    }
  };
  
  // Check if member exists
  if (!member) {
    console.log('[getMemberColor] No member provided, using theme default');
    return getDefaultColor();
  }
  
  console.log('[getMemberColor] Member found:', {
    id: member.id,
    displayName: member.displayName,
    displayHexColor: member.displayHexColor,
    hasRoles: !!member.roles,
    rolesCache: member.roles ? member.roles.cache.size : 0
  });
  
  // Discord.js v14 provides displayHexColor directly on GuildMember
  // It returns the hex color of the highest role, or #000000 if none
  if (member.displayHexColor !== '#000000') {
    console.log('[getMemberColor] Using role color:', member.displayHexColor);
    return member.displayHexColor;
  }
  
  console.log('[getMemberColor] No role color (default #000000), using theme default');
  // Fallback to theme default if no role color or color is default
  return getDefaultColor();
}

/**
 * Ensure member data is populated for a message.
 * Discord.js doesn't always populate the member property when fetching messages,
 * so we need to manually fetch it if it's missing.
 * 
 * For webhook messages (which don't have member data), attempts to find the
 * real guild member by matching the webhook's display name.
 * 
 * @param {Object} message - Discord Message object
 * @param {Object} guild - Discord Guild object
 * @param {Map} cache - Optional cache to store fetched members and avoid repeated API calls
 * @returns {Promise<Object|null>} GuildMember object or null if fetch fails
 */
async function ensureMemberData(message, guild, cache = null) {
  // If member is already present, return it
  if (message.member) {
    return message.member;
  }
  
  // If there's no author or guild, we can't fetch member data
  if (!message.author || !guild) {
    console.warn('ensureMemberData: Missing author or guild');
    return null;
  }
  
  // Check cache first if provided (use webhook:username for webhook messages)
  const cacheKey = message.webhookId ? `webhook:${message.author.username}` : message.author.id;
  if (cache && cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }
  
  // Try to fetch the member from the guild (non-webhook message)
  try {
    console.debug(`Fetching member data for user ${message.author.id} (${message.author.username})`);
    const member = await guild.members.fetch(message.author.id);
    // Store in cache if provided
    if (cache) {
      cache.set(cacheKey, member);
    }
    return member;
  } catch (error) {
    // Silently return null - member not found
    // When member fetch fails, getMemberColor will use default white color
    return null;
  }
}

module.exports = {
  getDisplayName,
  getMemberColor,
  ensureMemberData
};
