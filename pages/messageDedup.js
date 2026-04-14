'use strict';

// In-memory nonce cache to prevent duplicate message sends.
// Each nonce is stored with its timestamp; entries expire after NONCE_TTL_MS.

const NONCE_TTL_MS = 60000; // 1 minute
const MAX_NONCE_LENGTH = 128;
const seenNonces = new Map();

function cleanupOldNonces() {
    const now = Date.now();
    for (const [key, timestamp] of seenNonces) {
        if (now - timestamp > NONCE_TTL_MS) {
            seenNonces.delete(key);
        }
    }
}

// Run periodic cleanup every 5 minutes to keep the map from growing unbounded
// even during periods of low traffic when the hot-path cleanup alone may not run.
setInterval(cleanupOldNonces, 5 * 60 * 1000).unref();

/**
 * Check whether a nonce has already been processed, and if not, mark it as seen.
 * Returns true if the nonce is a duplicate (already seen), false if it is new.
 * A missing, empty, or oversized nonce is never treated as a duplicate so that
 * old clients without nonce support continue to work normally.
 */
exports.checkAndMarkNonce = function checkAndMarkNonce(nonce) {
    if (
        !nonce ||
        typeof nonce !== 'string' ||
        nonce.trim() === '' ||
        nonce.length > MAX_NONCE_LENGTH
    ) {
        return false;
    }
    cleanupOldNonces();
    if (seenNonces.has(nonce)) {
        return true;
    }
    seenNonces.set(nonce, Date.now());
    return false;
};
