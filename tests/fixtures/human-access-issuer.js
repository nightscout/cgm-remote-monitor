'use strict';

// Actual Ed25519 sign/verify for synthetic access fixtures. Private material is
// closure-local test data, not a serving-mode issuer or an exported key record.
const { generateKeyPairSync, sign } = require('node:crypto');
const { createHumanAccess } = require('../../lib/human-session/access');

module.exports = function humanAccessFixture ({ tenant, mode = tenant === 'single' ? 'single' : 'multi',
  now = () => Math.floor(Date.now() / 1000), issuer = 'synthetic-nightscout-human-access',
  audiences = { data: 'synthetic-human-data', management: 'synthetic-human-management' } } = {}) {
  if (!tenant) throw new TypeError('Explicit fixture authority binding required');
  const keys = ['data', 'management'].map(purpose => {
    const pair = generateKeyPairSync('ed25519');
    return { tenant, purpose, kid: 'human-' + purpose + '-v1', publicKey: pair.publicKey, current: true,
      sign: async input => sign(null, input, pair.privateKey) };
  });
  return Object.freeze({ access: createHumanAccess({ issuer, audiences, keys, mode, now }), keys,
    acceptedKeys: keys.map(({ kid, purpose }) => ({ kid, purpose, active: true })), issuer, audiences });
};
