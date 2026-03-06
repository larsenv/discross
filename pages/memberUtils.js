'use strict';
/**
 * Shared utilities for member data and role color handling
 * This module consolidates member-related functions to ensure consistency
 * across all message rendering pages.
 */

const { normalizeWeirdUnicode } = require('./unicodeUtils');

/**
 * Get the display name following Discord's order:
 * server nickname -> Discord global name -> Discord username
 *
 * @param {Object} member - Discord GuildMember object (may be null)
 * @param {Object} author - Discord User object from message author
 * @returns {string} Display name to show
 */
function getDisplayName(member, author) {
  let name;
  if (member && member.nickname) {
    // Server nickname (guild nickname) first
    name = member.nickname;
  } else if (member && member.user && member.user.globalName) {
    // Discord global name (from user object)
    name = member.user.globalName;
  } else if (member && member.user && member.user.username) {
    name = member.user.username;
  } else if (member) {
    // Fallback to member display name
    name = member.displayName;
  } else if (author && author.globalName) {
    // For webhooks or when no member data, use author data
    name = author.globalName;
  } else if (author && author.username) {
    name = author.username;
  }

  return normalizeWeirdUnicode(name || 'Unknown User');
}

/**
 * Get the member's highest role color or default to white
 *
 * @param {Object} member - Discord GuildMember object (may be null)
 * @returns {string} Hex color string (e.g., "#ffffff")
 */
function getMemberColor(member) {
  if (!member || !member.roles) {
    return '#ffffff'; // Default white color
  }

  // member.roles.color returns the highest role that has a non-zero color set
  const colorRole = member.roles.color;
  if (!colorRole) {
    return '#ffffff'; // No colored role found
  }

  // Convert Discord color integer to hex
  return `#${colorRole.color.toString(16).padStart(6, '0')}`;
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
  // If there's no author or guild, we can't fetch member data
  if (!message.author || !guild) {
    console.warn('ensureMemberData: Missing author or guild');
    return null;
  }

  // Application webhooks (slash command bot responses) have applicationId === webhookId.
  // For those, we can fetch the bot member by author ID to get role colors.
  const isAppWebhook =
    message.webhookId && message.applicationId && message.webhookId === message.applicationId;

  // Check cache first if provided (use webhook:username for plain webhook messages)
  const cacheKey =
    message.webhookId && !isAppWebhook ? `webhook:${message.author.username}` : message.author.id;
  if (cache && cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  // For regular (non-webhook) messages and application webhook messages, fetch from
  // guild to get a fully-resolved member object with all roles populated (Discord.js
  // serves this from its own member cache when available, so repeated calls are cheap).
  if (!message.webhookId || isAppWebhook) {
    try {
      const member = await guild.members.fetch(message.author.id);
      if (cache) {
        cache.set(cacheKey, member);
      }
      return member;
    } catch (error) {
      // guild.members.fetch() failed (e.g. bot lost access). Fall back to the
      // partial message.member — role colors may not be resolved in this case.
      const fallback = message.member || null;
      if (cache) {
        cache.set(cacheKey, fallback);
      }
      return fallback;
    }
  }

  // For plain webhook messages, message.member will be null; return it as-is
  const result = message.member || null;
  if (cache) {
    cache.set(cacheKey, result);
  }
  return result;
}

module.exports = {
  getDisplayName,
  getMemberColor,
  ensureMemberData,
};
