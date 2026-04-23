const crypto = require('crypto');

/**
 * AES-256-GCM encryption for user API keys.
 *
 * Each encrypted blob stores its own random IV + auth tag, so identical
 * plaintexts produce different ciphertexts (semantic security).
 *
 * Master key must be a 64-char hex string (32 bytes) in process.env.MASTER_ENCRYPTION_KEY.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;       // 128-bit IV
const TAG_LENGTH = 16;      // 128-bit auth tag

/**
 * Derive the 32-byte master key from hex env var.
 * Throws on startup if missing or malformed — fail fast.
 */
function _getMasterKey() {
    const hex = process.env.MASTER_ENCRYPTION_KEY;
    if (!hex || hex.length < 64) {
        throw new Error('[crypto] MASTER_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
    }
    return Buffer.from(hex, 'hex');
}

/**
 * Encrypt a plaintext string.
 * @param {string} plaintext
 * @returns {string} base64-encoded blob: IV (16) + TAG (16) + ciphertext
 */
function encrypt(plaintext) {
    if (!plaintext) return '';
    const key = _getMasterKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final()
    ]);
    const tag = cipher.getAuthTag();

    // Pack: IV + TAG + ciphertext → single base64 string
    const blob = Buffer.concat([iv, tag, encrypted]);
    return blob.toString('base64');
}

/**
 * Decrypt a base64 blob produced by encrypt().
 * @param {string} blob - base64 string
 * @returns {string} original plaintext
 */
function decrypt(blob) {
    if (!blob) return '';
    const key = _getMasterKey();
    const data = Buffer.from(blob, 'base64');

    if (data.length < IV_LENGTH + TAG_LENGTH + 1) {
        throw new Error('[crypto] encrypted blob too short');
    }

    const iv = data.subarray(0, IV_LENGTH);
    const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
    ]);
    return decrypted.toString('utf8');
}

/**
 * Generate a random 32-byte master key as hex string.
 * Use this once to create your MASTER_ENCRYPTION_KEY env var.
 * @returns {string} 64-char hex string
 */
function generateMasterKey() {
    return crypto.randomBytes(32).toString('hex');
}

module.exports = { encrypt, decrypt, generateMasterKey };
