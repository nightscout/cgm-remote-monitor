'use strict';

// A synthetic deployment signing secret for tests (decision
// deployment-signing-secret): the derived-key set, and a private file holding
// the secret for configurations that read NS_SIGNING_SECRET_FILE.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const derived = require('../../lib/secrets/derived-signing');

const SECRET = 'synthetic-test-deployment-signing-secret-000000000000';
const signing = derived.fromSecret(Buffer.from(SECRET));
let shared;
// Writes the secret into `dir` (or one process-wide temporary file) and returns its path.
function file (dir) {
  if (dir) { const target = path.join(dir, 'signing-secret'); fs.writeFileSync(target, SECRET, { mode: 0o600 }); return target; }
  if (!shared) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-signing-fixture-'));
    shared = path.join(base, 'signing-secret');
    fs.writeFileSync(shared, SECRET, { mode: 0o600 });
    process.once('exit', () => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ } });
  }
  return shared;
}
const env = dir => ({ NS_SIGNING_SECRET_FILE: file(dir) });
const DATA_REALM = Object.freeze({ issuer: 'synthetic-registry-lab', audience: 'synthetic-data' });
module.exports = { SECRET, signing, file, env, DATA_REALM };
