'use strict';

// Native D15 state, actual API status serialization and actual realtime frame
// serialization. Authority/projection are synthetic; this is a settings discriminator.
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');
const express = require('express'), request = require('supertest');
const scope = require('../lib/storage/tenant-scope');
const { createLab, enabled } = require('./fixtures/tenant-registry-lab');
const { optInSuite } = require('./support/opt-in');
class Socket extends EventEmitter {
  constructor (host) { super(); this.request = { headers: { host }, rawHeaders: ['Host', host], socket: {} }; this.sent = []; this.rooms = new Set(); this.id = 'synthetic'; }
  emit (event, value) { this.sent.push({ event, value }); return true; }
  disconnect () { super.emit('disconnect'); }
  join (room) { this.rooms.add(room); } leave (room) { this.rooms.delete(room); }
}
optInSuite(enabled(), 'disposable PostgreSQL/Vault registry lab')('registry realtime persisted settings discriminator', function () {
  this.timeout(120000);
  it('RT_REGISTRY_D15: stored units/plugins/thresholds reach both HTTP status and socket frames; update changes identity and missing state refuses', async function () {
    let lab, provision, runtime, presentation, protocol, role;
    const previous = scope.getTenancyMode();
    try {
      scope.setTenancyMode('multi'); lab = await createLab();
      const A = randomUUID(), B = randomUUID();
      provision = require('../lib/tenant-registry/provision').createProvisioning(lab.provisioningOptions());
      for (const [id, host] of [[A, 'settings-a.example.test'], [B, 'settings-b.example.test']]) assert.equal((await provision.provision({ id, hosts: [host] })).outcome, 'created');
      role = 'rt_display_' + lab.id; const password = randomBytes(16).toString('hex');
      await lab.admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
      for (const ns of [lab.namespaces.settings, lab.namespaces.operatorPolicy]) {
        await lab.admin.query(`GRANT USAGE ON SCHEMA "${ns}" TO "${role}"`);
        await lab.admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${ns}" TO "${role}"`);
      }
      const url = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI); url.username = role; url.password = password;
      const tenantSettings = { connectionString: url.toString(), namespaces: { settings: lab.namespaces.settings, operatorPolicy: lab.namespaces.operatorPolicy } };
      await lab.admin.query(`UPDATE "${lab.namespaces.settings}".tenant_settings SET version=2,values=$2 WHERE tenant_id=$1`, [A, { DISPLAY_UNITS: 'mmol', enable: ['bgnow', 'iob'], bgHigh: 170, bgTargetTop: 160, bgTargetBottom: 90, bgLow: 80 }]);
      runtime = await require('../lib/server/serve/preview-realtime').registryMode({ connectionString: lab.urls.realtime, registry: { namespace: lab.namespaces.registry, maxTenants: 100, refreshMs: 500 }, maxTenants: 100, tenantSettings });
      presentation = require('../lib/tenant-settings/presentation-reader')(tenantSettings);
      const environment = require('../lib/server/tenant-app/environment');
      const env = await require('../lib/server/tenant-app/presentation-environment').forRequest({ reader: presentation, tenant: A, env: environment({}), request: { method: 'GET', path: '/status' }, domains: ['entries'] });
      const app = express(); app.enable('api'); app.extendedClientSettings = env.extendedSettings;
      app.use(require('../lib/api/status')(app, { sendJSONStatus: (req, res, next) => next(), extensions: () => (req, res, next) => next() }, env,
        { authorization: { isPermitted: () => (req, res, next) => next() } }, { authorizeStatus: async () => ({}) }));
      const http = await request(app).get('/status').set('Accept', 'application/json'); assert.equal(http.status, 200);
      const current = await runtime.config.readCurrent(A);
      assert.equal(current.env.settings.units, 'mmol', 'RT_REGISTRY_D15 realtime uses committed units');
      assert.deepEqual(current.env.settings.enable, env.settings.enable, 'stored plugin selection');
      const next = { identity: current.identity, checkpoint: 1, rows: [], frame: { delta: false, lastUpdated: 1, sgvs: [] } };
      const projection = { warm: () => true, wake () {}, last: () => next, fresh: async () => next };
      protocol = require('../lib/server/realtime/protocol').create({ admission: { resolve: async () => A }, readCurrent: runtime.config.readCurrent,
        api: { authorizeSocket: async () => ({ permissions: { read: true, write: false, write_treatment: false, ack: false }, collections: [] }), executeSocketMutation: async () => ({ replyArgs: [] }) },
        domains: ['entries'], runtime: () => projection });
      const socket = new Socket('settings-a.example.test'); await protocol.prepare(socket); protocol.bind(socket, '/');
      await Promise.all(socket.listeners('authorize').map(fn => fn({ status: true, secret: 'synthetic' })));
      const frames = socket.sent.filter(row => row.event === 'dataUpdate'); assert.ok(frames.length > 0);
      assert.deepEqual(frames.at(-1).value.status.settings, http.body.settings, 'HTTP and realtime serialize the same committed effective settings');
      const foreign = await runtime.config.readCurrent(B); assert.equal(foreign.env.settings.units, 'mg/dl');
      await lab.admin.query(`UPDATE "${lab.namespaces.settings}".tenant_settings SET version=3,values=$2 WHERE tenant_id=$1`, [A, { DISPLAY_UNITS: 'mg/dl', enable: ['bgnow'] }]);
      const changed = await runtime.config.readCurrent(A); assert.notEqual(changed.identity, current.identity); assert.equal(changed.env.settings.units, 'mg/dl');
      await lab.admin.query(`DELETE FROM "${lab.namespaces.settings}".tenant_settings WHERE tenant_id=$1`, [A]);
      await assert.rejects(runtime.config.readCurrent(A), { code: 'SETTINGS_POLICY_UNAVAILABLE' });
    } finally {
      if (protocol) protocol.close(); if (runtime) await runtime.close(); if (presentation) await presentation.close(); if (provision) await provision.close();
      if (lab && role) { await lab.admin.query(`DROP OWNED BY "${role}"`); await lab.admin.query(`DROP ROLE "${role}"`); }
      if (lab) await lab.close(); scope.setTenancyMode(previous);
    }
  });
});
