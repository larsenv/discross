'use strict';
/**
 * Minimal WebAuthn (FIDO2) verification, implemented with Node's built-in
 * `crypto` so no extra dependency is needed.
 *
 * Scope: what Discross actually uses — registration attestation parsing to
 * recover the credential public key, and assertion (login) signature
 * verification. Attestation statements themselves are NOT cryptographically
 * validated (attestation conveyance is 'none' here); we only trust the key the
 * authenticator hands us, which is the standard posture for a consumer login.
 *
 * Supported credential algorithms: ES256 (-7, EC P-256) and RS256 (-257).
 */

const crypto = require('crypto');

// --- tiny CBOR decoder (only the subset WebAuthn structures use) ------------
// Handles unsigned/negative ints, byte/text strings, arrays and maps — enough
// for attestation objects and COSE keys. Returns { value, offset }.
function decodeCBOR(buf, offset = 0) {
    const first = buf[offset++];
    const major = first >> 5;
    const info = first & 0x1f;

    let length = info;
    if (info === 24) length = buf[offset++];
    else if (info === 25) {
        length = buf.readUInt16BE(offset);
        offset += 2;
    } else if (info === 26) {
        length = buf.readUInt32BE(offset);
        offset += 4;
    } else if (info === 27) {
        length = Number(buf.readBigUInt64BE(offset));
        offset += 8;
    } else if (info > 27) {
        throw new Error('Unsupported CBOR additional info: ' + info);
    }

    switch (major) {
        case 0: // unsigned int
            return { value: length, offset };
        case 1: // negative int
            return { value: -1 - length, offset };
        case 2: // byte string
            return { value: buf.subarray(offset, offset + length), offset: offset + length };
        case 3: // text string
            return {
                value: buf.toString('utf8', offset, offset + length),
                offset: offset + length,
            };
        case 4: {
            // array
            const arr = [];
            for (let i = 0; i < length; i++) {
                const r = decodeCBOR(buf, offset);
                arr.push(r.value);
                offset = r.offset;
            }
            return { value: arr, offset };
        }
        case 5: {
            // map
            const map = new Map();
            for (let i = 0; i < length; i++) {
                const k = decodeCBOR(buf, offset);
                const v = decodeCBOR(buf, k.offset);
                map.set(k.value, v.value);
                offset = v.offset;
            }
            return { value: map, offset };
        }
        default:
            throw new Error('Unsupported CBOR major type: ' + major);
    }
}

// --- authenticatorData parsing ----------------------------------------------
// Layout: rpIdHash(32) | flags(1) | signCount(4) | [attestedCredentialData] | [ext]
function parseAuthData(authData) {
    if (authData.length < 37) throw new Error('authData too short');
    const rpIdHash = authData.subarray(0, 32);
    const flags = authData[32];
    const signCount = authData.readUInt32BE(33);
    const result = {
        rpIdHash,
        userPresent: !!(flags & 0x01),
        userVerified: !!(flags & 0x04),
        attestedCredentialDataIncluded: !!(flags & 0x40),
        signCount,
    };

    if (result.attestedCredentialDataIncluded) {
        // aaguid(16) | credIdLen(2) | credId(L) | COSEpublicKey(rest)
        let ptr = 37 + 16;
        const credIdLen = authData.readUInt16BE(ptr);
        ptr += 2;
        result.credentialId = authData.subarray(ptr, ptr + credIdLen);
        ptr += credIdLen;
        // The COSE key is the remaining CBOR; decode it so we stop at its end
        // (there may be trailing extension data we don't care about).
        const { value: cose } = decodeCBOR(authData, ptr);
        result.credentialPublicKey = cose;
    }
    return result;
}

// Convert a decoded COSE_Key map into a Node public KeyObject via JWK.
function coseToKeyObject(cose) {
    const kty = cose.get(1);
    if (kty === 2) {
        // EC2
        const crvId = cose.get(-1);
        const crv = crvId === 1 ? 'P-256' : crvId === 2 ? 'P-384' : crvId === 3 ? 'P-521' : null;
        if (!crv) throw new Error('Unsupported EC curve: ' + crvId);
        return crypto.createPublicKey({
            key: {
                kty: 'EC',
                crv,
                x: Buffer.from(cose.get(-2)).toString('base64url'),
                y: Buffer.from(cose.get(-3)).toString('base64url'),
            },
            format: 'jwk',
        });
    }
    if (kty === 3) {
        // RSA
        return crypto.createPublicKey({
            key: {
                kty: 'RSA',
                n: Buffer.from(cose.get(-1)).toString('base64url'),
                e: Buffer.from(cose.get(-2)).toString('base64url'),
            },
            format: 'jwk',
        });
    }
    throw new Error('Unsupported COSE key type: ' + kty);
}

function coseAlgToHash(cose) {
    const alg = cose.get(3);
    // -7 ES256 / -257 RS256 → SHA-256; -35 ES384/-258 RS384 → SHA-384; etc.
    if (alg === -7 || alg === -257) return 'sha256';
    if (alg === -35 || alg === -258) return 'sha384';
    if (alg === -36 || alg === -259) return 'sha512';
    return 'sha256';
}

function normalizeB64url(s) {
    return (s || '').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Parse a registration response. Returns the credential id and the COSE public
 * key bytes to persist. Throws on malformed input.
 *
 * @param {{clientDataJSON:string, attestationObject:string}} response - base64 fields
 * @param {{expectedChallenge:string, expectedRpId:string}} expected
 */
function verifyRegistration(response, expected) {
    const clientData = JSON.parse(Buffer.from(response.clientDataJSON, 'base64').toString('utf8'));
    if (clientData.type !== 'webauthn.create') throw new Error('Unexpected clientData type');
    if (normalizeB64url(clientData.challenge) !== normalizeB64url(expected.expectedChallenge)) {
        throw new Error('Challenge mismatch');
    }
    assertOrigin(clientData.origin, expected.expectedRpId);

    const attestation = decodeCBOR(Buffer.from(response.attestationObject, 'base64')).value;
    const authData = parseAuthData(attestation.get('authData'));
    if (!authData.userPresent) throw new Error('User not present');
    assertRpIdHash(authData.rpIdHash, expected.expectedRpId);
    if (!authData.credentialPublicKey) throw new Error('No attested credential data');

    // Re-encode the COSE key deterministically for storage. We keep the raw
    // authData COSE bytes by re-serializing via the credentialId slice instead;
    // simplest is to store the public key as SPKI DER, which Node can re-import.
    const keyObject = coseToKeyObject(authData.credentialPublicKey);
    return {
        credentialId: Buffer.from(authData.credentialId).toString('base64url'),
        publicKeyDer: keyObject.export({ type: 'spki', format: 'der' }),
        signCount: authData.signCount,
    };
}

/**
 * Verify a login assertion signature against a stored SPKI public key.
 *
 * @param {{clientDataJSON:string, authenticatorData:string, signature:string}} response
 * @param {{publicKeyDer:Buffer, expectedChallenge:string, expectedRpId:string, storedSignCount:number}} expected
 * @returns {{ok:boolean, newSignCount:number}}
 */
function verifyAssertion(response, expected) {
    const clientDataBuf = Buffer.from(response.clientDataJSON, 'base64');
    const clientData = JSON.parse(clientDataBuf.toString('utf8'));
    if (clientData.type !== 'webauthn.get') throw new Error('Unexpected clientData type');
    if (normalizeB64url(clientData.challenge) !== normalizeB64url(expected.expectedChallenge)) {
        throw new Error('Challenge mismatch');
    }
    assertOrigin(clientData.origin, expected.expectedRpId);

    const authDataBuf = Buffer.from(response.authenticatorData, 'base64');
    const authData = parseAuthData(authDataBuf);
    if (!authData.userPresent) throw new Error('User not present');
    assertRpIdHash(authData.rpIdHash, expected.expectedRpId);

    // Signed data = authenticatorData || SHA-256(clientDataJSON)
    const clientDataHash = crypto.createHash('sha256').update(clientDataBuf).digest();
    const signedData = Buffer.concat([authDataBuf, clientDataHash]);

    const keyObject = crypto.createPublicKey({
        key: expected.publicKeyDer,
        format: 'der',
        type: 'spki',
    });
    const signature = Buffer.from(response.signature, 'base64');

    // ECDSA signatures from authenticators are ASN.1 DER (Node's default);
    // RSA is PKCS#1 v1.5. Node picks the scheme from the key type. Hash is
    // SHA-256 for the algorithms we register (ES256/RS256).
    const ok = crypto.verify('sha256', signedData, keyObject, signature);
    if (!ok) throw new Error('Signature verification failed');

    // Signature counter must be strictly increasing when the authenticator
    // supports it (a stuck-at-zero counter is allowed by spec for some keys).
    if (authData.signCount !== 0 || expected.storedSignCount !== 0) {
        if (authData.signCount <= expected.storedSignCount) {
            throw new Error('Sign counter did not increase — possible cloned authenticator');
        }
    }

    return { ok: true, newSignCount: authData.signCount };
}

function assertOrigin(origin, rpId) {
    let host;
    try {
        host = new URL(origin).hostname;
    } catch {
        throw new Error('Invalid origin');
    }
    // The RP ID must equal or be a registrable suffix of the origin host.
    if (host !== rpId && !host.endsWith('.' + rpId)) {
        throw new Error(`Origin ${origin} does not match RP ID ${rpId}`);
    }
}

function assertRpIdHash(rpIdHash, rpId) {
    const expected = crypto.createHash('sha256').update(rpId).digest();
    if (!crypto.timingSafeEqual(rpIdHash, expected)) {
        throw new Error('RP ID hash mismatch');
    }
}

module.exports = { verifyRegistration, verifyAssertion };
