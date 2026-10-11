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

// True when `discordID` may not act in this channel because it is age-restricted
// and Discord hasn't age-verified their account. Used to gate every send path,
// not just viewing, so a hand-crafted request can't bypass the channel gate.
async function isNsfwBlocked(chnl, discordID) {
    if (!isNsfwChannel(chnl)) return false;
    const { isAgeVerified } = require('./ageVerification');
    return !(await isAgeVerified(discordID));
}

module.exports = { isNsfwChannel, isNsfwBlocked };
