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

module.exports = {
    generateCaptcha,
    verifyCaptcha,
};
