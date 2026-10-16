'use strict';

const crypto = require('crypto');

// Secret key for signing CAPTCHA tokens
const CAPTCHA_SECRET = crypto.randomBytes(32).toString('hex');

function generateCaptcha() {
    const ops = ['+', '-', '*'];
    const op = ops[crypto.randomInt(ops.length)];
    let a, b, answer, question;

    if (op === '+') {
        a = crypto.randomInt(1, 16);
        b = crypto.randomInt(1, 16);
        answer = String(a + b);
        question = `What is ${a} + ${b}?`;
    } else if (op === '-') {
        a = crypto.randomInt(5, 21);
        b = crypto.randomInt(1, a);
        answer = String(a - b);
        question = `What is ${a} - ${b}?`;
    } else {
        a = crypto.randomInt(2, 10);
        b = crypto.randomInt(2, 10);
        answer = String(a * b);
        question = `What is ${a} * ${b}?`;
    }

    // The token goes into the page, so it must not contain the answer. Instead
    // the signature covers the answer plus a random nonce and the timestamp;
    // verifyCaptcha recomputes it from whatever the visitor typed.
    const timestamp = Date.now();
    const nonce = crypto.randomBytes(8).toString('hex');
    const token = `${timestamp}:${nonce}:${signCaptcha(answer, timestamp, nonce)}`;

    return { question, token };
}

function signCaptcha(answer, timestamp, nonce) {
    return crypto
        .createHmac('sha256', CAPTCHA_SECRET)
        .update(`captcha:${answer}:${timestamp}:${nonce}`)
        .digest('hex');
}

// Buffer.from(x, 'hex') silently drops trailing junk, so validate the shape
// first; otherwise a signature with extra characters appended would still match.
function safeEqualHex(provided, expected) {
    if (typeof provided !== 'string' || !/^[0-9a-f]+$/i.test(provided)) return false;
    const a = Buffer.from(provided, 'hex');
    const b = Buffer.from(expected, 'hex');
    return (
        provided.length === expected.length && a.length === b.length && crypto.timingSafeEqual(a, b)
    );
}

function verifyCaptcha(userAnswer, token) {
    if (!token || userAnswer === undefined || userAnswer === null) {
        return false;
    }

    const parts = String(token).split(':');
    if (parts.length !== 3) {
        return false;
    }

    const [timestampStr, nonce, providedSig] = parts;
    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) {
        return false;
    }

    // Check expiration (30 minutes)
    if (Date.now() - timestamp > 30 * 60 * 1000) {
        return false;
    }

    const expectedSig = signCaptcha(String(userAnswer).trim(), timestampStr, nonce);
    return safeEqualHex(providedSig, expectedSig);
}

// --- Signed "captcha passed" cookie ------------------------------------------
// The guest send handler must not trust a plain "passed" string cookie: any
// client can set that by hand and skip the captcha entirely. Instead, once the
// captcha is solved we issue an HMAC-signed pass tied to a timestamp, and the
// send handler verifies the signature (and freshness) before accepting a guest
// message. Reuses CAPTCHA_SECRET, which is per-process.
const PASS_TTL_MS = 12 * 60 * 60 * 1000; // a solved captcha is good for 12h

function issueCaptchaPass() {
    const timestamp = Date.now();
    const sig = crypto
        .createHmac('sha256', CAPTCHA_SECRET)
        .update(`pass:${timestamp}`)
        .digest('hex');
    return `${timestamp}:${sig}`;
}

function verifyCaptchaPass(cookieValue) {
    if (!cookieValue || typeof cookieValue !== 'string') return false;
    const parts = cookieValue.split(':');
    if (parts.length !== 2) return false;
    const [timestampStr, providedSig] = parts;
    const timestamp = parseInt(timestampStr, 10);
    if (!Number.isFinite(timestamp)) return false;
    if (Date.now() - timestamp > PASS_TTL_MS) return false;

    const expectedSig = crypto
        .createHmac('sha256', CAPTCHA_SECRET)
        .update(`pass:${timestampStr}`)
        .digest('hex');
    return safeEqualHex(providedSig, expectedSig);
}

module.exports = {
    generateCaptcha,
    verifyCaptcha,
    issueCaptchaPass,
    verifyCaptchaPass,
};
