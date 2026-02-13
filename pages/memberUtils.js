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
 * Get the member's highest role color or use fallback color
 * 
 * @param {Object} member - Discord GuildMember object (may be null)
 * @param {string} fallbackColor - Color to use when no role color is available (default: "#ffffff")
 * @returns {string} Hex color string (e.g., "#ffffff")
 */
function getMemberColor(member, fallbackColor = "#ffffff") {
  if (!member || !member.roles || !member.roles.highest) {
    console.debug(`getMemberColor: No member or roles, returning fallback ${fallbackColor}`);
    return fallbackColor;
  }
  
  const roleColor = member.roles.highest.color;
  if (roleColor === 0) {
    console.debug(`getMemberColor: Role color is 0 (default), returning fallback ${fallbackColor}`);
    return fallbackColor;
  }
  
  // Convert Discord color integer to hex
  const hexColor = `#${roleColor.toString(16).padStart(6, '0')}`;
  console.debug(`getMemberColor: Converting color ${roleColor} to ${hexColor}`);
  return hexColor;
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
    // Silently return null - member not found (#11)
    // Failed member fetches will result in white/fallback colors
    return null;
  }
}

module.exports = {
  getDisplayName,
  getMemberColor,
  ensureMemberData
};
