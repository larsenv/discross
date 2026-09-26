'use strict';

// Returns true if a channel is age-restricted, including a thread whose
// parent channel is marked NSFW (threads don't carry their own `nsfw` flag).
function isNsfwChannel(chnl) {
    if (!chnl) return false;
    if (chnl.nsfw) return true;
    if (typeof chnl.isThread === 'function' && chnl.isThread() && chnl.parent) {
        return !!chnl.parent.nsfw;
    }
    return false;
}

module.exports = { isNsfwChannel };
