'use strict';

const crypto = require('node:crypto');

// Synthetic lab provider only. No signing-key export or production backend.
module.exports = function provider () {
  const encryption = crypto.randomBytes(32);
  const signing = crypto.randomBytes(32);
  return {
    signingVersion: 1,
    async encrypt (input) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', encryption, iv);
      return Buffer.concat([iv, cipher.update(input), cipher.final(), cipher.getAuthTag()]).toString('base64');
    },
    async decrypt (ciphertext) {
      const bytes = Buffer.from(ciphertext, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', encryption, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
    },
    async sign (input) { return crypto.createHmac('sha256', signing).update(input).digest(); },
    async verify (version, input, signature) {
      return version === 1 && crypto.timingSafeEqual(
        crypto.createHmac('sha256', signing).update(input).digest(), signature);
    }
  };
};
