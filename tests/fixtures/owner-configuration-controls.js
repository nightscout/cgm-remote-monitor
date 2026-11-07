'use strict';

// Native laboratory preload only. Mutate actual module bytes in memory; no
// product/source file or assertion is changed, and no result is manufactured.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { setTimeout: delay } = require('node:timers/promises');
const pg = require('pg');
const root = path.resolve(__dirname, '../..');
const control = process.env.NS_OWNER_CONFIGURATION_CONTROL;
const known = ['read-authority', 'write-fence', 'policy-generation', 'boot-environment'];
if (control !== undefined) assert.ok(known.includes(control), 'Unknown owner configuration semantic control');
const held = new Set();
async function hold (kind) {
  const file = process.env['NS_OWNER_CONFIGURATION_' + kind.toUpperCase() + '_BARRIER'];
  if (!file || !fs.existsSync(file + '.armed') || held.has(kind)) return;
  held.add(kind); process.stdout.write('OWNER_CONFIGURATION_' + kind.toUpperCase() + '_HELD\n');
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error('Owner configuration synthetic barrier timeout');
    await delay(10);
  }
}
global[Symbol.for('owner.configuration.native.control')] = { hold };
const boundaries = {
  'read-authority': { file: 'lib/server/serve/owner-preview.js',
    before: 'return !!current && current.active === true && current.canConfigure === true;', after: 'return true;' },
  'write-fence': { file: 'lib/tenant-settings/postgres.js',
    before: 'const authority = await configurationAuthority(actor, true);', after: 'const authority = { active: true, canConfigure: true };' },
  'policy-generation': { file: 'lib/tenant-settings/postgres.js',
    before: 'await fence(actor.tenant, policyGeneration);', after: '/* deliberate native policy-generation fence omission */' },
  'boot-environment': { file: 'lib/server/tenant-app/presentation-environment.js',
    before: 'units: state.effective.DISPLAY_UNITS.value, showSeconds: state.effective.SHOW_SECONDS.value',
    after: 'units: env.settings.units, showSeconds: env.settings.showSeconds' }
};
if (require.main === module) {
  assert.deepEqual(process.argv.slice(2), ['--check'], 'Only source --check mode is supported');
  const additional = [
    ['lib/tenant-settings/postgres.js', 'return transaction(actor.tenant, () => configurationAuthority(actor, false));'],
    ['lib/operator-policy/postgres-read.js', 'return { generation: row.generation, policy: structuredClone(row.policy) };']
  ];
  for (const boundary of Object.values(boundaries)) {
    const source = fs.readFileSync(path.join(root, boundary.file), 'utf8');
    assert.equal(source.split(boundary.before).length, 2, 'Control boundary must be unique: ' + boundary.file);
    assert.notEqual(source.replace(boundary.before, boundary.after), source);
  }
  for (const [file, before] of additional) assert.equal(fs.readFileSync(path.join(root, file), 'utf8').split(before).length, 2,
    'Barrier boundary must be unique: ' + file);
  process.stdout.write('Four source mutation boundaries and two barrier boundaries are unique; native controls UNMEASURED\n');
  process.exit(0);
}
function replace (source, before, after) {
  assert.equal(source.split(before).length, 2, 'Native control boundary must be unique');
  return source.replace(before, after);
}
const originalLoader = Module._extensions['.js'];
Module._extensions['.js'] = function (loaded, filename) {
  const settings = path.join(root, 'lib/tenant-settings/postgres.js');
  const policy = path.join(root, 'lib/operator-policy/postgres-read.js');
  const selected = control && boundaries[control];
  if (filename !== settings && filename !== policy && (!selected || filename !== path.join(root, selected.file))) {
    return originalLoader(loaded, filename);
  }
  let source = fs.readFileSync(filename, 'utf8');
  if (filename === settings) source = replace(source,
    'return transaction(actor.tenant, () => configurationAuthority(actor, false));',
    "return transaction(actor.tenant, () => configurationAuthority(actor, false)).then(async current => { await global[Symbol.for('owner.configuration.native.control')].hold('authority'); return current; });");
  if (filename === policy) source = replace(source,
    'return { generation: row.generation, policy: structuredClone(row.policy) };',
    "await global[Symbol.for('owner.configuration.native.control')].hold('policy'); return { generation: row.generation, policy: structuredClone(row.policy) };");
  if (selected && filename === path.join(root, selected.file)) source = replace(source, selected.before, selected.after);
  loaded._compile(source, filename);
};

// Hold only the completed synthetic presentation response requested explicitly
// by the test; body bytes have already been generated from that operation's env.
const http = require('node:http');
const end = http.ServerResponse.prototype.end;
http.ServerResponse.prototype.end = function (...args) {
  if (this.req.method === 'GET' && /^\/api\/v1\/status(?:[/.]|$)/.test(this.req.url) &&
      this.req.headers['x-owner-configuration-hold'] === '1' && process.env.NS_OWNER_CONFIGURATION_STATUS_BARRIER) {
    hold('status').then(() => end.apply(this, args)).catch(error => this.destroy(error));
    return this;
  }
  return end.apply(this, args);
};

// Count statement classes only; never store text, parameters, URIs or row data.
const audit = { queries: 0, ddl: 0 };
const query = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
  audit.queries++;
  if (typeof text === 'string' && /^\s*(CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE)\b/i.test(text)) audit.ddl++;
  return query.apply(this, args);
};
process.once('exit', () => {
  if (process.env.NS_OWNER_CONFIGURATION_QUERY_AUDIT) fs.writeFileSync(process.env.NS_OWNER_CONFIGURATION_QUERY_AUDIT,
    JSON.stringify(audit), { mode: 0o600 });
});
