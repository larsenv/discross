'use strict';

const auth = require('../authentication.js');

// Module-level cache: webhook channel ID → Discord.js Webhook object.
// fetchWebhooks() is a Discord API call on every message send; caching it
// here means the first send to a channel pays the cost, subsequent sends are free.
const _webhookCache = new Map();

async function getOrCreateWebhook(channel, guildID) {
  // Threads don't own webhooks — use the parent text channel
  const webhookChannel = channel.isThread() ? channel.parent : channel;
  const channelId = webhookChannel.id;

  if (_webhookCache.has(channelId)) {
    return _webhookCache.get(channelId);
  }

  const existingWebhooks = await webhookChannel.fetchWebhooks();
  let webhook = existingWebhooks.find(
    (w) => w.owner && (w.owner.username === 'discross beta' || w.owner.username === 'Discross')
  );

  if (!webhook) {
    webhook = await webhookChannel.createWebhook({
      name: 'Discross',
      avatar: 'pages/static/resources/logo.png',
      reason: 'Discross uses webhooks to send messages',
    });
    auth.dbQueryRun('INSERT INTO webhooks VALUES (?,?,?)', [guildID, webhook.id, webhook.token]);
  }

  _webhookCache.set(channelId, webhook);
  return webhook;
}

module.exports = { getOrCreateWebhook };
