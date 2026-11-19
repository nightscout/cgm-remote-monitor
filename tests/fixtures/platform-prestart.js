'use strict';

// The deployment's pre-start step for fixtures that start serving roles
// (decision platform-application-boundary): the actual admin verification
// service checks the role's exact configuration and publishes its proof
// before the role starts. The parent fixture owns the proof writer; a role
// child receives only its own credentials. A refused verification revokes
// every proof in the namespace, so the role then refuses at start, as in a
// deployment.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const quote = name => '"' + name.replaceAll('"', '""') + '"';

async function install (admin, { namespace, adminURI, readers, registry }) {
  const writer = namespace + '_writer', password = crypto.randomBytes(24).toString('hex');
  await admin.query('CREATE ROLE ' + quote(writer) + " LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '" + password + "'");
  await require('../../lib/server/serve/platform-verification').install(admin, { namespace, writer, readers });
  if (registry) {
    for (const sql of require('../../lib/tenant-registry/postgres').grants({ namespace: registry, enumerators: [writer] })) await admin.query(sql);
  }
  const url = new URL(adminURI); url.username = writer; url.password = password;
  return Object.freeze({ namespace, writer, writerURI: url.toString() });
}

async function verify ({ namespace, writerURI, targets, source }) {
  const service = require('../../lib/server/serve/platform-verification-admin').create({ namespace, connectionString: writerURI, targets }, source);
  try { return await service.verify(); } finally { await service.close(); }
}

// For fixtures whose start() returns its child synchronously. Never throws:
// a refusal is returned, and the caller starts the role, which must refuse.
function verifySync ({ directory, ...input }) {
  const file = path.join(directory, 'pre-start-' + crypto.randomBytes(8).toString('hex') + '.json');
  fs.writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [__filename, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  } catch (error) { stdout = String(error.stdout || ''); } finally { fs.rmSync(file, { force: true }); }
  try { return JSON.parse(stdout.trim().split('\n').pop()); } catch { return { status: 'refused', code: 'PRE_START_OUTCOME_UNKNOWN' }; }
}

module.exports = { install, verify, verifySync };

if (require.main === module) {
  const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  require('../../lib/storage/tenant-scope').setTenancyMode('multi');
  verify(input).then(result => {
    process.stdout.write(JSON.stringify(result) + '\n'); process.exit(0);
  }, error => {
    process.stdout.write(JSON.stringify({ status: 'refused', code: error.code || null, diagnostic: error.verificationDiagnostic || null }) + '\n'); process.exit(1);
  });
}
