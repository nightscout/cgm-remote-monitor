'use strict';

// Single-site access-token signing with one operator-supplied Ed25519 private
// key, held in this process. The data and management keys are derived from it
// with HKDF-SHA256 under distinct labels, so the two purposes keep distinct key
// material and key IDs, as the Vault Transit profile requires. Key material is
// never logged, exported or written; only public keys leave this module.
const { createPrivateKey, createPublicKey, createHash, hkdfSync, sign } = require('node:crypto');
const { privateSetting, configured: present, refuse } = require('./private-setting');
const NAME = 'OIDC_ACCESS_SIGNING_KEY';
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SALT = 'nightscout-human-access-local-v1';
const invalidKey = () => refuse(NAME + ' must hold one Ed25519 private key in PEM (PKCS#8) form');

function configured (source) { return present(source, NAME); }

// Issuer and audiences derive from the site's canonical origin, so two sites
// never accept each other's access tokens.
function namespace (origin) {
  let url;
  try { url = new URL(origin); } catch { refuse('A local OIDC signing key requires OIDC_ORIGIN'); }
  if (url.origin !== origin || url.protocol !== 'https:' || origin.length > 200) refuse('A local OIDC signing key requires an HTTPS OIDC_ORIGIN');
  return { issuer: 'nightscout-human-access:' + origin,
    audiences: { data: 'nightscout-human-data:' + origin, management: 'nightscout-human-management:' + origin } };
}

function load (source) {
  const value = privateSetting(source, NAME, { limit: 16384 });
  // An environment value may carry the PEM line breaks as literal \n.
  const pem = value.includes('\n') ? value : value.replace(/\\n/g, '\n');
  let root;
  try { root = createPrivateKey({ key: pem, format: 'pem' }); } catch { invalidKey(); }
  if (root.type !== 'private' || root.asymmetricKeyType !== 'ed25519') invalidKey();
  const seed = Buffer.from(root.export({ format: 'jwk' }).d, 'base64url');
  const keys = ['data', 'management'].map(purpose => {
    const derived = Buffer.from(hkdfSync('sha256', seed, SALT, purpose, 32));
    const der = Buffer.concat([PKCS8_ED25519, derived]);
    const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    derived.fill(0); der.fill(0);
    const publicKey = createPublicKey(privateKey);
    const kid = 'local-' + purpose + '-' +
      createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('base64url').slice(0, 22);
    return { tenant: 'single', purpose, kid, current: true, publicKey, sign: async bytes => sign(null, bytes, privateKey) };
  });
  seed.fill(0);
  return { ...namespace(source.OIDC_ORIGIN), keys };
}

module.exports = { configured, namespace, load, NAME };
