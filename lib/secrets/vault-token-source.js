'use strict';

const fs = require('node:fs');
const path = require('node:path');

// A Vault Agent token sink: an absolute path whose contents are read again on every
// provider call, so a token the Agent renews or re-issues is used without a restart.
// It is never combined with, and never falls back to, an environment reference. Shared
// by every configuration loader that names a Vault credential source (preview tenants,
// owner credential issuance, human access signing).
function tokenFilePath (value, invalid) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > 4096 ||
      !path.isAbsolute(value) || value.endsWith('/') || value !== path.normalize(value)) {
    invalid();
  }
  return value;
}

function tokenFileReader (file) {
  return async function getToken (options = {}) {
    let token;
    try {
      token = await fs.promises.readFile(file, { encoding: 'utf8', signal: options.signal });
    } catch {
      // The sink is missing, unreadable or aborted: fail this operation closed.
      throw Object.assign(new Error('Secrets provider credential unavailable'), { code: 'SECRETS_PROVIDER_UNAVAILABLE' });
    }
    token = token.trim();
    if (!token || token.length > 4096 || /\s/.test(token)) {
      throw Object.assign(new Error('Secrets provider credential unavailable'), { code: 'SECRETS_PROVIDER_UNAVAILABLE' });
    }
    return token;
  };
}

module.exports = { tokenFilePath, tokenFileReader };
