'use strict';

// No import-time services. --plan is static; execution requires parent-owned
// phase invocation and explicitly supplied resources. Never creates containers.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const plan = Object.freeze({ version: 1, phases: ['uds-ownership', 'profile-port-differential', 'profile-catalogue-upgrade', 'profile-differential', 'joined-role-recovery', 'joined-data-parity', 'joined-consumer-handoff', 'joined-consumer-plugin-ack', 'joined-socket-epoch', 'joined-browser-consumer'],
  invoke: 'node tests/fixtures/realtime-preview/early.js --execute <phase> <captureDir> (NS_RT_EARLY_NATIVE=1)',
  adapter: '{sourceDir,captureDir,phaseId,control:null,env}',
  profileEnv: ['NS_RT_PROFILE_CONFIG', 'NS_TEST_POSTGRES_ADMIN_URI', 'CUSTOMCONNSTR_mongo', 'NS_RT_SOURCE_HEAD', 'NS_RT_PROFILE_WRITER_URI (direct port phase only)'],
  profileContract: 'root-owned existing API private UDS, original socketcredential env, admitted tenant/profile namespace, owned Mongo database; no substitute auth/executor',
  noProvisioning: true, evidence: 'read independent physical rows and real replies before assertions; stop first mismatch',
  udsCapture: 'short absolute captureDir (<=65 UTF8 bytes), unique owned child0700, no real foreign paths',
  pins: { postgres: 'sha256:066167ff39c2a612402ce99b734ea1cff92a9d1f2ac52f697a5f0384f0d88d6b',
    mongo: 'sha256:09f940d01e0c09abbfd246a2b10965cbf86a87c9c1dad86b374f925a084976c8',
    vault: 'sha256:8794a735d581b92ae3d138e677fc79b5722749ce53674334507f2141e35da8c8' } });
const stat = file => { const s = fs.lstatSync(file); return { dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode & 0o777, socket: s.isSocket() }; };
async function uds (input) {
  const http = require('node:http'), ipc = require('../../../lib/server/realtime/ipc');
  assert(path.isAbsolute(input.captureDir) && Buffer.byteLength(input.captureDir) <= 65, 'short absolute owned captureDir required');
  const directory = fs.mkdtempSync(path.join(input.captureDir, 'uds-')); fs.chmodSync(directory, 0o700);
  const owned = [], events = []; let channel;
  const write = () => fs.writeFileSync(path.join(input.captureDir, 'uds-results.json'), JSON.stringify(events, null, 2) + '\n');
  async function server (file) {
    const s = http.createServer((req, res) => res.end()); owned.push(s);
    await new Promise((resolve, reject) => { s.once('error', reject); s.listen(file, resolve); }); return s;
  }
  const options = file => ({ socketPath: file, maxBytes: 4096, timeoutMs: 1000 });
  try {
    for (const kind of ['file', 'symlink', 'socket']) {
      const file = path.join(directory, kind + '.sock');
      if (kind === 'file') fs.writeFileSync(file, 'owned sentinel');
      if (kind === 'symlink') fs.symlinkSync(path.join(directory, 'deliberately-absent'), file);
      if (kind === 'socket') await server(file);
      const before = stat(file);
      await assert.rejects(ipc.open(options(file), () => ({ '/authorize': async () => ({ ok: true }) })), /PATH_EXISTS/);
      assert.deepEqual(stat(file), before, 'UDS_FOREIGN_PATH_REFUSAL leaves preexisting owned test object untouched');
      events.push({ kind, before, after: stat(file), refused: true }); write();
    }
    // Controlled same-UID test replacement exactly between publication and
    // lstat: never a real foreign endpoint, never suppress a mismatched inode.
    const raced = path.join(directory, 'raced.sock'), standby = path.join(directory, 'standby.sock');
    await server(standby); const replacementBefore = stat(standby), originalLink = fs.linkSync;
    fs.linkSync = function (from, to) {
      originalLink(from, to);
      if (to === raced) { fs.renameSync(to, path.join(directory, 'published-backup.sock')); fs.renameSync(standby, to); }
    };
    try { await assert.rejects(ipc.open(options(raced), () => ({ '/authorize': async () => ({ ok: true }) })), /OWNERSHIP_REFUSED/); }
    finally { fs.linkSync = originalLink; }
    const replacementAfter = fs.existsSync(raced) ? stat(raced) : null;
    events.push({ kind: 'post-link-replacement', before: replacementBefore, after: replacementAfter }); write();
    assert.deepEqual(replacementAfter, replacementBefore, 'UDS_POST_LINK_OWNERSHIP failed publication must not adopt or unlink replacement');
    const file = path.join(directory, 'api.sock');
    channel = await ipc.open(options(file), () => ({ '/authorize': async () => ({ ok: true }) }));
    const before = stat(file); const internal = fs.readdirSync(directory).filter(name => name.startsWith('.ns-')).map(name => ({ path: path.join(directory, name), ...stat(path.join(directory, name)) })); const reply = await ipc.client(options(file))('/authorize', {});
    await channel.close(); channel = null;
    events.push({ kind: 'normal', before, internal, accepted: reply.ok, absent: !fs.existsSync(file) }); write();
    assert(reply.ok && !fs.existsSync(file), 'UDS_OWNED_CLOSE normal own endpoint removed');
    channel = await ipc.open(options(file), () => ({ '/authorize': async () => ({ ok: true }) }));
    const original = stat(file), backup = path.join(directory, 'moved.sock'); fs.renameSync(file, backup);
    await server(file); const replacement = stat(file);
    await channel.close(); channel = null;
    const after = fs.existsSync(file) ? stat(file) : null;
    events.push({ kind: 'replacement', original, replacement, after }); write();
    assert.deepEqual(after, replacement, 'UDS_REPLACEMENT_INODE actual Node close must preserve a different owned test server inode');
  } finally {
    if (channel) await channel.close();
    await Promise.all(owned.map(s => new Promise(resolve => s.listening ? s.close(resolve) : resolve())));
    // Every name is generated in this owned unique directory; never a real service.
    fs.rmSync(directory, { recursive: true });
    events.push({ kind: 'cleanup', directory, absent: !fs.existsSync(directory) }); write();
  }
}
async function execute (input) {
  if (input.env?.NS_RT_EARLY_NATIVE !== '1' || !plan.phases.includes(input.phaseId) ||
      input.control !== null && (input.env.NS_RT_CONTROL_ID !== input.control || !/^[a-z0-9][a-z0-9_-]{0,95}$/.test(input.control))) throw new Error('EXPLICIT_PARENT_NATIVE_PHASE_REQUIRED');
  assert.equal(path.resolve(input.sourceDir), path.resolve(__dirname, '../../..'), 'stop source directory mismatch');
  const causal = ['lib/server/realtime/ipc.js', 'lib/server/realtime/protocol.js', 'lib/server/realtime/private-api.js',
    'lib/server/tenant-socket-write-executor.js', 'lib/server/socket-write-handlers.js', 'lib/server/tenant-app/profile.js',
    'lib/storage/postgres-collection-intent.js', 'lib/storage/postgres-entries-read.js', 'lib/storage/write-intent.js',
    'lib/server/tenant-socket-order-port.js', 'lib/server/serve/postgres-domains.js', 'lib/server/serve/evaluator-readiness.js',
    'migrations/candidates/postgres-profile-socket-order-v1.json',
    'tests/fixtures/realtime-preview/profile-differential.js', 'tests/fixtures/realtime-preview/profile-timestamps.js',
    'tests/fixtures/realtime-preview/wire-call.js', 'tests/fixtures/realtime-preview/wire-response.js', 'tests/fixtures/realtime-preview/profile-port.js',
    'tests/fixtures/realtime-preview/authority-epoch.js', 'tests/fixtures/realtime-preview/observe-evaluator.js',
    'tests/fixtures/realtime-preview/plugin-ack.js', 'tests/fixtures/realtime-preview/cold-acquisition.js',
    'tests/fixtures/realtime-preview/consumer.js', 'tests/fixtures/realtime-preview/roles.js',
    'tests/fixtures/realtime-preview/reader-grants.js', 'tests/fixtures/realtime-preview/joined.js', 'tests/fixtures/realtime-preview/runtime-directory.js'];
  const sourceFiles = Object.fromEntries(causal.map(file => [file, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(input.sourceDir, file))).digest('hex')]));
  fs.writeFileSync(path.join(input.captureDir, 'phase-source.json'), JSON.stringify({ sourceHead: input.env.NS_RT_SOURCE_HEAD || null,
    phaseId: input.phaseId, control: input.control, sourceFiles }, null, 2) + '\n');
  if (input.phaseId === 'profile-catalogue-upgrade') return require('./profile-upgrade')(input);
  if (input.phaseId === 'joined-consumer-plugin-ack') return require('./plugin-ack')(input);
  if (input.phaseId === 'joined-socket-epoch') return require('./authority-epoch')(input);
  if (input.phaseId === 'joined-consumer-handoff') return require('./consumer')(input);
  if (input.phaseId === 'joined-browser-consumer') return require('./browser')(input);
  if (input.phaseId === 'joined-data-parity') return require('./data-parity')(input);
  if (input.phaseId === 'joined-role-recovery') return require('./joined')(input);
  if (input.phaseId === 'uds-ownership') return uds(input);
  return require('./profile-differential')(input);
}
// The profile adapter reads this plan during CLI execution too.
module.exports = { plan, execute };
if (require.main === module) {
  if (process.argv[2] === '--plan') process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  else if (process.argv[2] === '--validate-config') {
    try {
      const phaseId = process.argv[3];
      if (!['profile-port-differential', 'profile-catalogue-upgrade', 'profile-differential'].includes(phaseId)) throw new Error('PROFILE_VALIDATION_PHASE_REQUIRED');
      const value = require('./profile-differential').configuration({ phaseId, env: process.env });
      process.stdout.write(JSON.stringify({ valid: true, phaseId, sourceHead: value.sourceHead, authorityBoundary: value.authorityBoundary || 'actual-private-api-current-client' }) + '\n');
    } catch (error) { console.error(error.code || error.message); process.exitCode = 1; }
  }
  else if (process.argv[2] === '--execute') execute({ sourceDir: path.resolve(__dirname, '../../..'), captureDir: process.argv[4],
    phaseId: process.argv[3], control: null, env: process.env }).catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
  else { console.error('Use --plan or explicitly granted --execute'); process.exitCode = 64; }
}
