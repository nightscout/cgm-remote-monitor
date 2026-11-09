'use strict';
// Bounded consumer child for the vault stages. It receives ONLY the public
// access configuration path, the Vault origin and the sign-only token (never
// the admin token), loads the production config loader from the executed
// source root, issues one DATA and one MANAGEMENT token through the
// nonexportable Transit signer and verifies them locally, then exits.
//   node vault-consumer.cjs <sourceRoot> <tenant> <mode>
const path = require('node:path');
const { createRequire } = require('node:module');
const [sourceRoot, tenant, mode] = process.argv.slice(2);
(async () => {
  for (const name of ['OIDC_ACCESS_CONFIG', 'HUMAN_VAULT_URL', 'HUMAN_VAULT_SIGN_TOKEN']) if (!process.env[name]) throw new Error('consumer env ' + name + ' required');
  if (process.env.HUMAN_VAULT_ADMIN_TOKEN) throw new Error('consumer must not receive the admin token');
  const req = createRequire(path.join(sourceRoot, 'package.json'));
  const access = req('./lib/human-session/access-config').loadHumanAccess({ source: process.env, mode, tenants: [tenant] });
  const at = Math.floor(Date.now() / 1000), kids = [];
  for (const purpose of ['data', 'management']) {
    const token = await access.issue({ tenant, subject: 'synthetic_consumer', session: 'synthetic_consumer_' + purpose, purpose,
      credentialVersion: 1, issuedAt: at, expiresAt: at + (purpose === 'management' ? 600 : 3600) });
    const claims = access.verify({ tenant, token });
    if (claims.purpose !== purpose || claims.sub !== 'synthetic_consumer') throw new Error('consumer verification mismatch');
    kids.push(claims.kid);
  }
  process.stdout.write(JSON.stringify({ consumer: 'vault-consumer', pid: process.pid, tenant, mode, issued: 2, verified: 2, kids }) + '\n');
})().then(() => process.exit(0), error => { process.stderr.write(JSON.stringify({ consumer: 'vault-consumer', error: error.message }) + '\n'); process.exit(1); });
