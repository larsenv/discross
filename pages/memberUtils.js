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
    // Otherwise Discord username (from user object)
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
    return author.username;
  }
  
  return "Unknown User";
}

/**
 * Get the member's highest role color or default to white
 * 
 * @param {Object} member - Discord GuildMember object (may be null)
 * @returns {string} Hex color string (e.g., "#ffffff")
 */
function getMemberColor(member) {
  if (!member || !member.roles || !member.roles.highest) {
    return "#ffffff"; // Default white color
  }
  
  const roleColor = member.roles.highest.color;
  if (roleColor === 0) {
    return "#ffffff"; // Default role has color 0, use white
  }
  
  // Convert Discord color integer to hex
  return `#${roleColor.toString(16).padStart(6, '0')}`;
}

/**
 * Ensure member data is populated for a message.
 * Discord.js doesn't always populate the member property when fetching messages,
 * so we need to manually fetch it if it's missing.
 * 
 * @param {Object} message - Discord Message object
 * @param {Object} guild - Discord Guild object
 * @returns {Promise<Object|null>} GuildMember object or null if fetch fails
 */
async function ensureMemberData(message, guild) {
  // If member is already present, return it
  if (message.member) {
    return message.member;
  }
  
  // If there's no author, we can't fetch member data
  if (!message.author) {
    return null;
  }
  
  // Try to fetch the member from the guild
  try {
    const member = await guild.members.fetch(message.author.id);
    return member;
  } catch (error) {
    console.error(`Failed to fetch member for user ${message.author.id}:`, error.message);
    return null;
  }
}

module.exports = {
  getDisplayName,
  getMemberColor,
  ensureMemberData
};
