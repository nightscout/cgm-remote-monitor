'use strict';

// A positive local Ed25519 mathematical proof, never a credential decision.
// Entry and encoded-byte budgets are fixed per process, not per tenant.
const crypto = require('node:crypto');
const MAX_PROOFS = 256, MAX_PROOF_BYTES = 1048576, MAX_PROOF_ENTRY_BYTES = 16384;
const proofs = new Map(); let proofBytes = 0;
const cost = (key, entry) => key.length + (entry.encoded?.length || 0);
function trim () {
  while (proofs.size > MAX_PROOFS || proofBytes > MAX_PROOF_BYTES) {
    const oldest = proofs.keys().next().value;
    proofBytes -= cost(oldest, proofs.get(oldest)); proofs.delete(oldest);
  }
}
module.exports = function signatureProof (input, publicKey, signature) {
  if (!(publicKey instanceof crypto.KeyObject) || publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
    return crypto.verify(null, input, publicKey, signature);
  }
  const key = crypto.getFips() + ':' + input.toString('base64') + ':' + signature.toString('base64');
  if (key.length > MAX_PROOF_ENTRY_BYTES) return crypto.verify(null, input, publicKey, signature);
  const entry = proofs.get(key); let encoded;
  if (entry) {
    // Native KeyObject material is immutable: the identical object means the
    // identical current public material. A different object must match exact
    // DER before any reuse. Cold misses never pay for an unused DER encoding.
    let matches = entry.publicKey === publicKey;
    if (!matches) {
      encoded = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
      const known = entry.encoded || entry.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
      matches = encoded === known;
      if (matches && !entry.encoded && key.length + known.length <= MAX_PROOF_ENTRY_BYTES) { entry.encoded = known; proofBytes += known.length; }
    }
    if (matches) {
      entry.publicKey = publicKey;
      proofs.delete(key); proofs.set(key, entry); trim(); return true;
    }
  }
  if (!crypto.verify(null, input, publicKey, signature)) return false;
  if (entry) { proofBytes -= cost(key, entry); proofs.delete(key); }
  const record = { publicKey, ...(encoded && key.length + encoded.length <= MAX_PROOF_ENTRY_BYTES ? { encoded } : {}) };
  proofs.set(key, record); proofBytes += cost(key, record); trim(); return true;
};
