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

// True when `discordID` may not see or post in this channel because it is
// age-restricted and they haven't confirmed they are 18 or older. Anonymous
// guests can never confirm, so they are always blocked.
function isNsfwBlocked(chnl, discordID) {
    if (!isNsfwChannel(chnl)) return false;
    return !require('../src/authentication').hasConfirmedAdult(discordID);
}

// Answers with the 18+ confirmation page when the channel is age-restricted and
// the user hasn't confirmed yet. Returns true when it responded, so callers can
// simply `return` afterwards.
function sendAgeGateIfNeeded(req, res, chnl, discordID) {
    if (!isNsfwBlocked(chnl, discordID)) return false;
    const auth = require('../src/authentication');
    const { render, toLocalPath } = require('./utils');
    const escape = require('escape-html');
    const urlSessionID = new URL(req.url, 'http://localhost').searchParams.get('sessionID');
    res.pageHeading = 'Age-restricted channel';
    res.writeHead(403, { 'Content-Type': 'text/html' });
    res.end(
        render('misc/nsfw-gate', {
            CHANNEL_NAME: escape(chnl.name || 'this channel'),
            TOKEN: escape(auth.createActionToken(auth.getRequestSessionID(req), 'nsfwconfirm')),
            RETURN: escape(toLocalPath(req.url)),
            SESSION_PARAM: urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '',
        })
    );
    return true;
}

module.exports = { isNsfwChannel, isNsfwBlocked, sendAgeGateIfNeeded };
