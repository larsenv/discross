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

    const timestamp = Date.now();
    const payload = `${answer}:${timestamp}`;
    const sig = crypto.createHmac('sha256', CAPTCHA_SECRET).update(payload).digest('hex');
    const token = `${payload}:${sig}`;

    return { question, token };
}

function verifyCaptcha(userAnswer, token) {
    if (!token || userAnswer === undefined || userAnswer === null) {
        return false;
    }

    const parts = String(token).split(':');
    if (parts.length !== 3) {
        return false;
    }

    const [expectedAnswer, timestampStr, expectedSig] = parts;
    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) {
        return false;
    }

    // Check expiration (30 minutes)
    if (Date.now() - timestamp > 30 * 60 * 1000) {
        return false;
    }

    const payload = `${expectedAnswer}:${timestampStr}`;
    const recomputedSig = crypto.createHmac('sha256', CAPTCHA_SECRET).update(payload).digest('hex');

    const buf1 = Buffer.from(expectedSig, 'hex');
    const buf2 = Buffer.from(recomputedSig, 'hex');
    if (buf1.length !== buf2.length || !crypto.timingSafeEqual(buf1, buf2)) {
        return false;
    }

    return String(userAnswer).trim() === expectedAnswer;
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
    const a = Buffer.from(providedSig, 'hex');
    const b = Buffer.from(expectedSig, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
    generateCaptcha,
    verifyCaptcha,
    issueCaptchaPass,
    verifyCaptchaPass,
};
