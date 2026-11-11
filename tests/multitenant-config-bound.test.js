'use strict';

// covers: lib/server/serve/config-file.js, lib/server/serve/preview-config.js, lib/server/serve/evaluator-config.js, lib/server/serve/owner-preview-config.js, lib/server/serve/admin-config.js, lib/server/serve/operation-cohort-config.js, lib/server/realtime/contract.js, lib/server/realtime/config.js, lib/server/realtime/admission.js, lib/tenant-connector/config.js
// One operator-settable bound on every multitenant role configuration file
// (MULTITENANT_CONFIG_MAX_BYTES), checked on the file's size and on the bytes
// read, and a refusal that names its cause: too large (size and limit), not a
// regular file, unreadable, or invalid JSON. The roster here is synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const configFile = require('../lib/server/serve/config-file');
const { PreviewConfigError } = require('../lib/server/serve/preview-config');

const MiB = 1048576;
const uuid = i => {
  const hex = i.toString(16).padStart(12, '0');
  return '7e57' + hex.slice(0, 4) + '-0000-4000-8000-' + hex;
};
// A synthetic api roster entry of about 640 bytes, the measured size per tenant.
function rosterTenant (i) {
  const n = String(i).padStart(5, '0');
  return { id: uuid(i), aliases: ['tenant-' + n + '.synthetic.example.test'],
    vault: { encryptionKey: 'tenant-' + n + '-data', signingKey: 'tenant-' + n + '-signing', signingVersion: 1,
      tokenFile: '/run/ns-vault/tenant-' + n + '/token' },
    settings: { enable: ['careportal', 'basal', 'dbsize', 'rawbg', 'iob', 'maker', 'cob', 'bwp', 'cage', 'iage', 'sage',
      'boluscalc', 'pushover', 'treatmentnotify', 'loop', 'pump', 'profile', 'food', 'openaps', 'bage', 'alexa', 'override',
      'speech', 'cors'], customTitle: 'Synthetic tenant ' + n, theme: 'colors', timeFormat: 12, nightMode: false,
    showRawbg: 'never', alarmTimeagoWarnMins: 15, alarmTimeagoUrgentMins: 30, language: 'en' } };
}
function apiConfig (count) {
  return { version: 1,
    postgres: { connectionEnv: 'CB_API_PG', readinessConnectionEnv: 'CB_READINESS_PG',
      namespaces: { entries: 'cb_entries', authorization: 'cb_authorization', secrets: 'cb_secrets', legacy: 'cb_legacy' } },
    vault: { address: 'http://127.0.0.1:18200', mount: 'cb_transit', allowInsecureLoopback: true },
    resolution: { mode: 'direct-alias' },
    tenants: Array.from({ length: count }, (_, i) => rosterTenant(i + 1)) };
}
const apiEnvironment = (file, extra = {}) => ({ MULTITENANT_PREVIEW_CONFIG: file,
  CB_API_PG: 'postgres://synthetic-api:synthetic@127.0.0.1:15432/config_bound',
  CB_READINESS_PG: 'postgres://synthetic-readiness:synthetic@127.0.0.1:15432/config_bound', ...extra });
const refusedWith = (code, pattern, Type = PreviewConfigError) => error =>
  error instanceof Type && error.code === code && pattern.test(error.message);

describe('multitenant configuration size bound (MULTITENANT_CONFIG_MAX_BYTES)', function () {
  this.timeout(30000);
  let dir;
  const write = (name, text) => { const file = path.join(dir, name); fs.writeFileSync(file, text); return file; };
  const oversize = () => write('oversize.json', JSON.stringify({ pad: 'x'.repeat(MiB) }));
  before(function () { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-config-bound-')); });
  after(function () { fs.rmSync(dir, { recursive: true, force: true }); });

  it('defaults to 1 MiB and accepts only a whole number of bytes within its range', function () {
    assert.equal(configFile.maxBytes({}), MiB);
    assert.equal(configFile.maxBytes({ MULTITENANT_CONFIG_MAX_BYTES: '' }), MiB);
    assert.equal(configFile.maxBytes({ MULTITENANT_CONFIG_MAX_BYTES: '65536' }), 65536);
    assert.equal(configFile.maxBytes({ MULTITENANT_CONFIG_MAX_BYTES: '67108864' }), 67108864);
    for (const raw of ['65535', '67108865', '0', '-1', '1e7', '4 MiB', '04194304', ' 4194304', '99999999999']) {
      assert.throws(() => configFile.maxBytes({ MULTITENANT_CONFIG_MAX_BYTES: raw }),
        refusedWith('CONFIG_FILE_LIMIT_INVALID', /MULTITENANT_CONFIG_MAX_BYTES: a whole number of bytes from 65536 to 67108864/, configFile.ConfigFileError), raw);
    }
  });

  it('refuses a 3,000-tenant api roster at the default bound and loads it with the bound raised', function () {
    const text = JSON.stringify(apiConfig(3000));
    assert.ok(text.length > 1.5 * MiB && text.length < 4 * MiB, 'synthetic roster size ' + text.length);
    const file = write('api-3000.json', text);
    assert.throws(() => require('../lib/server/serve/preview-config').load(apiEnvironment(file)),
      error => refusedWith('CONFIG_FILE_TOO_LARGE', /^MULTITENANT_PREVIEW_CONFIG is too large: \d+ bytes, over the limit of 1048576 bytes \(MULTITENANT_CONFIG_MAX_BYTES\)$/)(error) &&
        error.size === text.length && error.limit === MiB);
    const loaded = require('../lib/server/serve/preview-config').load(apiEnvironment(file, { MULTITENANT_CONFIG_MAX_BYTES: String(4 * MiB) }));
    assert.equal(loaded.bindings.size, 3000, 'LARGE_ROSTER_LOADED');
    assert.equal(loaded.providers.size, 3000);
  });

  it('enforces the bound on the bytes read when the size seen before reading was within it', function () {
    // A file that grows between the size check and the read (simulated: the
    // size check sees one byte) is refused on the bytes actually read.
    const file = oversize(), stat = fs.statSync;
    fs.statSync = function (name, ...rest) {
      const value = stat.call(this, name, ...rest);
      return name === file ? Object.assign(Object.create(Object.getPrototypeOf(value)), value, { size: 1 }) : value;
    };
    try {
      assert.throws(() => configFile.read(file, { source: {}, label: 'SYNTHETIC_CONFIG' }),
        error => error.code === 'CONFIG_FILE_TOO_LARGE' && error.size === null &&
          /SYNTHETIC_CONFIG is too large: more than 1048576 bytes/.test(error.message), 'READ_BOUND_ENFORCED');
    } finally { fs.statSync = stat; }
  });

  it('names each cause distinctly and never quotes the file', function () {
    const marker = 'SYNTHETIC_CONTENT_MARKER';
    const invalidJson = write('invalid.json', '{"' + marker + '": ');
    const cases = [
      [path.join(dir, 'missing.json'), 'CONFIG_FILE_UNREADABLE', /^MULTITENANT_PREVIEW_CONFIG cannot be read \(ENOENT\)$/],
      [dir, 'CONFIG_FILE_NOT_REGULAR', /^MULTITENANT_PREVIEW_CONFIG is not a regular file$/],
      [oversize(), 'CONFIG_FILE_TOO_LARGE', /^MULTITENANT_PREVIEW_CONFIG is too large: \d+ bytes, over the limit of 1048576 bytes/],
      [invalidJson, 'CONFIG_FILE_INVALID_JSON', /^MULTITENANT_PREVIEW_CONFIG is not valid JSON$/]
    ];
    for (const [file, code, pattern] of cases) {
      assert.throws(() => require('../lib/server/serve/preview-config').load(apiEnvironment(file)), error => {
        assert.ok(!error.message.includes(marker), 'no file contents in ' + error.message);
        return refusedWith(code, pattern)(error);
      }, code);
    }
    if (process.getuid && process.getuid() !== 0) {
      const locked = write('locked.json', '{}'); fs.chmodSync(locked, 0o000);
      assert.throws(() => require('../lib/server/serve/preview-config').load(apiEnvironment(locked)),
        refusedWith('CONFIG_FILE_UNREADABLE', /cannot be read \(EACCES\)/));
    }
  });

  it('applies the same bound and named causes in every role loader', function () {
    const big = oversize(), bad = write('bad.json', '{');
    const raised = { MULTITENANT_CONFIG_MAX_BYTES: String(2 * MiB) };
    const loaders = [
      ['MULTITENANT_EVALUATOR_CONFIG', (file, extra) => require('../lib/server/serve/evaluator-config').load({ MULTITENANT_EVALUATOR_CONFIG: file, ...extra })],
      ['MULTITENANT_OWNER_PREVIEW_CONFIG', (file, extra) => require('../lib/server/serve/owner-preview-config').load({ MULTITENANT_OWNER_PREVIEW_CONFIG: file, ...extra })],
      ['MULTITENANT_ADMIN_CONFIG', (file, extra) => require('../lib/server/serve/admin-config').load({ MULTITENANT_ADMIN_CONFIG: file, ...extra })],
      ['MULTITENANT_OPERATION_CONFIG', (file, extra) => require('../lib/server/serve/operation-cohort-config').load({ MULTITENANT_OPERATION_CONFIG: file, ...extra })],
      ['MULTITENANT_REALTIME_CONFIG', (file, extra) => require('../lib/server/realtime/config').load({ MULTITENANT_REALTIME_CONFIG: file, ...extra })],
      ['realtime admission file', (file, extra) => require('../lib/server/realtime/admission').load({ file, maxTenants: 10, source: { ...extra } })],
      ['vcpool: ', (file, extra) => require('../lib/tenant-connector/config').load({ [require('../lib/tenant-connector/config').CONFIG_ENV]: file, ...extra })]
    ];
    for (const [label, load] of loaders) {
      assert.throws(() => load(big, {}), error => error.code === 'CONFIG_FILE_TOO_LARGE' && error.message.includes(label) &&
        /over the limit of 1048576 bytes \(MULTITENANT_CONFIG_MAX_BYTES\)/.test(error.message), label + ' too large');
      assert.throws(() => load(bad, {}), error => error.code === 'CONFIG_FILE_INVALID_JSON' && error.message.includes(label), label + ' invalid JSON');
      // Within a raised bound the same file is read and refused for its content, not its size.
      assert.throws(() => load(big, raised), error => !configFile.isRefusal(error), label + ' read within a raised bound');
      assert.throws(() => load(big, { MULTITENANT_CONFIG_MAX_BYTES: '1' }), error => error.code === 'CONFIG_FILE_LIMIT_INVALID', label + ' invalid bound');
    }
  });
});
