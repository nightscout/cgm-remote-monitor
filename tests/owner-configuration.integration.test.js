'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { optInSuite } = require('./support/opt-in');
const createFixture = require('./fixtures/owner-configuration');
const endpoint = '/api/v1/tenant/settings';

// Distinct native suite: existing owner-preview/R70 nine-case capture is not
// changed. Every case below is UNMEASURED until this explicit opt-in is granted.
optInSuite(process.env.NS_OWNER_CONFIGURATION_DOCKER_TEST === '1', 'NS_OWNER_CONFIGURATION_DOCKER_TEST=1')(
  'explicit owner configuration CLI composition', function () {
    this.timeout(60000);
    const lab = createFixture();
    const { A, B } = lab;
    let left, right, beforeCase;
    const observations = [];
    const owner = (worker, tenant, method, body, credential = lab.token(tenant), resource = endpoint) =>
      lab.http(worker, tenant, method, resource, credential, body);
    async function status (worker, tenant, headers) {
      return lab.data.http(worker, tenant, 'GET', '/api/v1/status.json', await lab.data.localToken(tenant), undefined, headers);
    }
    async function current (tenant) {
      return (await lab.state()).current.find(row => row.tenant_id === tenant);
    }
    async function wait (worker, marker) {
      await lab.data.until(async () => {
        assert.equal(worker.exit, null, 'barrier worker must stay alive');
        return worker.stdout.includes(marker);
      }, marker);
    }
    async function refuseUnchanged (request, expected) {
      const before = await lab.state(); const result = await request();
      assert.equal(result.status, expected, JSON.stringify(result.body));
      assert.deepEqual(await lab.state(), before, 'refusal must not commit current/history effects');
      return result;
    }
    before(async () => { await lab.setup(); left = await lab.start(); right = await lab.start(); });
    beforeEach(async () => { await lab.reset(); beforeCase = await lab.state(); });
    afterEach(async function () {
      if (!lab.data.admin) return;
      observations.push({ case: this.currentTest.title, state: this.currentTest.state,
        before: beforeCase, after: await lab.state(),
        currentPolicyGenerations: (await lab.data.admin.query(`SELECT tenant_id,generation FROM ${lab.policyTable} ORDER BY tenant_id`)).rows,
        currentConfigurationAuthority: (await lab.data.admin.query(`SELECT tenant_id,active,can_configure FROM ${lab.authorityTable} ORDER BY tenant_id`)).rows });
    });
    after(async () => {
      try {
        for (const worker of [left, right].filter(Boolean)) if (!worker.exit) await lab.stop(worker);
      } finally {
        try { await lab.cleanup(); }
        finally {
          if (process.env.NS_OWNER_CONFIGURATION_REPORT) fs.writeFileSync(process.env.NS_OWNER_CONFIGURATION_REPORT,
            JSON.stringify({ scope: 'actual owner configuration CLI component', observations }, null, 2), { mode: 0o600 });
        }
      }
    });

    it('requires first-class configure for GET despite data wildcard and subject can_update', async function () {
      const explicitSubject = (await lab.data.admin.query(`SELECT can_update FROM preview_auth.tenant_owner_actors
        WHERE tenant_id=$1 AND principal=$2 AND consumer=$3`, [A, lab.SUBJECT, lab.consumer])).rows[0];
      assert.equal(explicitSubject.can_update, true);
      await lab.configure(A, true, false);
      await refuseUnchanged(() => owner(right, A, 'GET'), 403);
      await lab.configure(A, true, true);
      assert.equal((await owner(left, A, 'GET')).status, 200);
    });
    it('persists typed CAS/history through two actual workers with exactly one same-version winner', async function () {
      const responses = await Promise.all([left, right].map(worker => owner(worker, A, 'PUT', {
        expectedVersion: 1, values: { DISPLAY_UNITS: 'mmol', SHOW_SECONDS: true }
      })));
      assert.deepEqual(responses.map(result => result.status).sort(), [200, 409]);
      const stored = await lab.state();
      assert.deepEqual(stored.current.find(row => row.tenant_id === A), { tenant_id: A, version: 2,
        values: { DISPLAY_UNITS: 'mmol', SHOW_SECONDS: true } });
      assert.deepEqual(stored.current.find(row => row.tenant_id === B), { tenant_id: B, version: 1, values: {} });
      const audit = stored.history.filter(row => row.tenant_id === A && row.version === 2);
      assert.equal(audit.length, 1); assert.equal(audit[0].principal, lab.SUBJECT); assert.equal(audit[0].consumer, lab.consumer);
      for (const values of [{ SHOW_SECONDS: 'true' }, { TIMEZONE: 'UTC' }, { DISPLAY_UNITS: 'other' }]) {
        await refuseUnchanged(() => owner(right, A, 'PUT', { expectedVersion: 2, values }), 400);
      }
    });
    it('rolls back as a new version and refuses whole rollback under current operator pin', async function () {
      assert.equal((await owner(left, A, 'PUT', { expectedVersion: 1, values: { SHOW_SECONDS: true } })).status, 200);
      assert.equal((await owner(right, A, 'POST', { expectedVersion: 2, restoredFrom: 1 }, lab.token(A), endpoint + '/rollback')).status, 200);
      assert.deepEqual(await current(A), { tenant_id: A, version: 3, values: {} });
      const restored = (await lab.state()).history.find(row => row.tenant_id === A && row.version === 3);
      assert.equal(restored.operation, 'rollback'); assert.equal(restored.restored_from, 1);
      await lab.policy(A, { deployment: {}, overrides: { SHOW_SECONDS: { mode: 'pinned', pin: false } } });
      await refuseUnchanged(() => owner(left, A, 'POST', { expectedVersion: 3, restoredFrom: 2 }, lab.token(A), endpoint + '/rollback'), 403);
      const shown = await owner(right, A, 'GET'); assert.equal(shown.body.effective.SHOW_SECONDS.value, false);
      assert.equal(shown.body.effective.SHOW_SECONDS.source, 'operator-pin');
    });
    it('enforces current configure revoke with the same JWT on the next operation in another worker', async function () {
      const credential = lab.token(A);
      assert.equal((await owner(left, A, 'GET', undefined, credential)).status, 200);
      await lab.configure(A, false);
      await refuseUnchanged(() => owner(right, A, 'GET', undefined, credential), 403);
      await refuseUnchanged(() => owner(left, A, 'PUT', { expectedVersion: 1, values: {} }, credential), 403);
      await lab.configure(A, true);
      assert.equal((await owner(right, A, 'GET', undefined, credential)).status, 200);
    });
    it('fences revoke committed after initial authorization before the settings mutation transaction', async function () {
      const barrier = lab.barrier('authority');
      const worker = await lab.start({ extra: { NS_OWNER_CONFIGURATION_AUTHORITY_BARRIER: barrier.file } });
      let request;
      try {
        barrier.arm(); request = owner(worker, A, 'PUT', { expectedVersion: 1, values: { SHOW_SECONDS: true } });
        await wait(worker, 'OWNER_CONFIGURATION_AUTHORITY_HELD');
        const before = await lab.state(); await lab.configure(A, false); barrier.release();
        const response = await request;
        assert.equal(response.status, 403, 'WRITE_FENCE_REFUSAL: committed revoke must prevent version/history change');
        assert.deepEqual(await lab.state(), before, 'WRITE_FENCE_EFFECTS: independent state/history remain unchanged');
      } finally { barrier.release(); if (request) await request.catch(() => {}); await lab.stop(worker); }
    });
    it('fences operator generation changed after captured policy before settings mutation', async function () {
      const barrier = lab.barrier('policy');
      const worker = await lab.start({ extra: { NS_OWNER_CONFIGURATION_POLICY_BARRIER: barrier.file } });
      let request;
      try {
        barrier.arm(); request = owner(worker, A, 'PUT', { expectedVersion: 1, values: { SHOW_SECONDS: true } });
        await wait(worker, 'OWNER_CONFIGURATION_POLICY_HELD');
        const before = await lab.state();
        await lab.policy(A, { deployment: {}, overrides: { SHOW_SECONDS: { mode: 'pinned', pin: false } } }); barrier.release();
        const response = await request;
        assert.equal(response.status, 409, 'POLICY_FENCE_REFUSAL: stale policy generation must not commit');
        assert.deepEqual(await lab.state(), before, 'POLICY_FENCE_EFFECTS: independent state/history remain unchanged');
      } finally { barrier.release(); if (request) await request.catch(() => {}); await lab.stop(worker); }
    });
    it('next actual DATA status in another worker consumes committed owner settings with B unchanged', async function () {
      const before = await status(right, A); assert.equal(before.status, 200);
      assert.equal(before.body.settings.units, 'mg/dl'); assert.equal(before.body.settings.showSeconds, false);
      const accepted = await owner(left, A, 'PUT', { expectedVersion: 1, values: { DISPLAY_UNITS: 'mmol', SHOW_SECONDS: true } });
      assert.equal(accepted.status, 200);
      const next = await status(right, A), foreign = await status(left, B);
      assert.equal(next.status, 200); assert.equal(next.body.settings.units, 'mmol', 'NEXT_STATUS_UNITS: actual DATA handler must use fresh committed config');
      assert.equal(next.body.settings.showSeconds, true, 'NEXT_STATUS_SECONDS');
      assert.equal(foreign.body.settings.units, 'mg/dl'); assert.equal(foreign.body.settings.showSeconds, false);
      await lab.policy(A, { deployment: {}, overrides: { DISPLAY_UNITS: { mode: 'pinned', pin: 'mg/dl' } } });
      const pinned = await status(left, A); assert.equal(pinned.body.settings.units, 'mg/dl');
      assert.equal((await current(A)).values.DISPLAY_UNITS, 'mmol', 'operator pin must not delete owner history/value');
    });
    it('keeps held presentation response and concurrent tenants bound to their operation-local environment', async function () {
      const barrier = lab.barrier('status');
      const worker = await lab.start({ extra: { NS_OWNER_CONFIGURATION_STATUS_BARRIER: barrier.file } });
      let request;
      try {
        barrier.arm(); request = status(worker, A, { 'X-Owner-Configuration-Hold': '1' });
        await wait(worker, 'OWNER_CONFIGURATION_STATUS_HELD');
        assert.equal((await owner(left, A, 'PUT', { expectedVersion: 1, values: { DISPLAY_UNITS: 'mmol', SHOW_SECONDS: true } })).status, 200);
        const [next, foreign] = await Promise.all([status(right, A), status(worker, B)]);
        assert.equal(next.body.settings.units, 'mmol'); assert.equal(foreign.body.settings.units, 'mg/dl');
        barrier.release(); const old = await request;
        assert.equal(old.body.settings.units, 'mg/dl'); assert.equal(old.body.settings.showSeconds, false);
      } finally { barrier.release(); if (request) await request.catch(() => {}); await lab.stop(worker); }
    });
    it('display reader outage refuses presentation but preserves authorized raw uploads and exact SGV/date', async function () {
      assert.equal((await owner(left, A, 'PUT', { expectedVersion: 1, values: { DISPLAY_UNITS: 'mmol', SHOW_SECONDS: true } })).status, 200);
      await lab.data.admin.query(`REVOKE SELECT ON ${lab.policyTable} FROM "${lab.roles.display}"`);
      try {
        const refused = await status(right, A); assert.equal(refused.status, 503);
        assert.deepEqual(refused.body, { error: 'AUTHORITY_UNAVAILABLE' }, 'display SQL details must not escape');
        const now = Date.now(), credential = await lab.data.localToken(A);
        const upload = await lab.data.http(right, A, 'POST', '/api/v1/entries.json', credential,
          [{ type: 'sgv', sgv: 147, date: now, dateString: new Date(now).toISOString(), identifier: 'owner-config-raw-' + now }]);
        assert.equal(upload.status, 200, JSON.stringify(upload.body));
        const stored = (await lab.data.admin.query(`SELECT doc FROM preview_data.entries WHERE tenant_id=$1 AND doc->>'identifier'=$2`,
          [A, 'owner-config-raw-' + now])).rows;
        assert.equal(stored.length, 1); assert.equal(stored[0].doc.sgv, 147); assert.equal(stored[0].doc.date, now);
        const exchange = await lab.data.exchange(right, A); assert.equal(exchange.status, 200);
      } finally { await lab.data.admin.query(`GRANT SELECT ON ${lab.policyTable} TO "${lab.roles.display}"`); }
      assert.equal((await status(right, A)).status, 200);
    });
    it('cold boots DATA with unsafe or unavailable display role while raw upload/exchange and lazy recovery remain independent', async function () {
      assert.equal((await owner(left, A, 'PUT', { expectedVersion: 1, values: { DISPLAY_UNITS: 'mmol', SHOW_SECONDS: true } })).status, 200);
      const scenarios = [
        { name: 'unsafe', disable: `GRANT INSERT ON ${lab.policyTable} TO "${lab.roles.display}"`,
          restore: `REVOKE INSERT ON ${lab.policyTable} FROM "${lab.roles.display}"` },
        { name: 'unavailable', disable: `ALTER ROLE "${lab.roles.display}" NOLOGIN`,
          restore: `ALTER ROLE "${lab.roles.display}" LOGIN` }
      ];
      for (const scenario of scenarios) {
        await lab.data.admin.query(scenario.disable);
        let worker;
        try {
          worker = await lab.start();
          const now = Date.now(), identifier = 'owner-config-cold-' + scenario.name + '-' + now;
          const upload = await lab.data.http(worker, A, 'POST', '/api/v1/entries.json', await lab.data.localToken(A),
            [{ type: 'sgv', sgv: 167, date: now, dateString: new Date(now).toISOString(), identifier }]);
          assert.equal(upload.status, 200, scenario.name + ': cold display validation must not block authorized raw upload');
          const stored = (await lab.data.admin.query(`SELECT doc FROM preview_data.entries WHERE tenant_id=$1 AND doc->>'identifier'=$2`, [A, identifier])).rows;
          assert.equal(stored.length, 1); assert.equal(stored[0].doc.sgv, 167); assert.equal(stored[0].doc.date, now);
          assert.equal((await lab.data.exchange(worker, A)).status, 200, scenario.name + ': exchange must not initialize display reader');
          assert.equal((await status(worker, A)).status, 503, scenario.name + ': presentation lazily refuses display dependency');
          await lab.data.admin.query(scenario.restore);
          const recovered = await status(worker, A);
          assert.equal(recovered.status, 200, scenario.name + ': next presentation retries current read-only readiness');
          assert.equal(recovered.body.settings.units, 'mmol'); assert.equal(recovered.body.settings.showSeconds, true);
        } finally {
          await lab.data.admin.query(scenario.restore);
          if (worker) await lab.stop(worker);
        }
      }
    });
    it('keeps DATA owner404 and OWNER DATA/operator404 with independent state unchanged', async function () {
      const before = await lab.state();
      assert.equal((await lab.data.http(left, A, 'GET', endpoint, lab.token(A))).status, 404);
      assert.equal((await lab.http(right, A, 'GET', '/api/v3/entries', lab.token(A))).status, 404);
      assert.equal((await lab.http(right, A, 'GET', '/api/v1/operator/tenants/' + A + '/policy', lab.token(A))).status, 404);
      assert.deepEqual(await lab.state(), before);
      for (const credential of [await lab.data.localToken(A), lab.token(B), lab.token(A, { purpose: 'data' }), lab.token(A, { exp: Math.floor(Date.now() / 1000) + 1000 })]) {
        await refuseUnchanged(() => owner(left, A, 'GET', undefined, credential), 401);
      }
    });
    it('restricts settings writer to sentinel fencing and display identity to current presentation reads', async function () {
      const before = await lab.state();
      for (const sql of [
        `UPDATE ${lab.policyTable} SET generation=generation+1`,
        `UPDATE ${lab.authorityTable} SET can_configure=false`,
        `DELETE FROM ${lab.historyTable}`
      ]) await assert.rejects(lab.queryAs('settings', A, sql), error => error.code === '42501');
      assert.equal((await lab.queryAs('settings', A, `UPDATE ${lab.authorityTable} SET owner_fence=true`)).rowCount, 1);
      for (const sql of [
        `SELECT * FROM ${lab.historyTable}`, `SELECT * FROM ${lab.authorityTable}`,
        `UPDATE ${lab.settingsTable} SET values='{}'`
      ]) await assert.rejects(lab.queryAs('display', A, sql), error => error.code === '42501');
      assert.deepEqual(await lab.state(), before, 'sentinel and refused SQL cannot change settings/history');
    });
    it('refuses unsafe policy grants and disabled configuration RLS before any listener bind', async function () {
      await lab.data.admin.query(`GRANT UPDATE ON ${lab.policyTable} TO "${lab.roles.settings}"`);
      try { await lab.start({ refused: true }); }
      finally { await lab.data.admin.query(`REVOKE UPDATE ON ${lab.policyTable} FROM "${lab.roles.settings}"`); }
      await lab.data.admin.query(`ALTER TABLE ${lab.authorityTable} DISABLE ROW LEVEL SECURITY`);
      try { await lab.start({ refused: true }); }
      finally { await lab.data.admin.query(`ALTER TABLE ${lab.authorityTable} ENABLE ROW LEVEL SECURITY`); }
    });
    it('closes both real listeners and records zero serving DDL statements on shutdown', async function () {
      const worker = await lab.start(); await lab.stop(worker);
      assert.deepEqual(worker.exit, { code: 0, signal: null });
    });
  });
