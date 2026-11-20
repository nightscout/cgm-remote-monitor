'use strict';

// covers: lib/server/serve/preview-api.js, lib/server/serve/preview-config.js, lib/cli/commands/multitenant.js, lib/server/serve/index.js, lib/tenant-authorization/access-token.js, lib/tenant-authorization/access-postgres.js
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { once } = require('node:events');
const createFixture = require('./fixtures/multitenant-preview-replicas');
const { optInSuite } = require('./support/opt-in');

optInSuite(process.env.NS_MULTITENANT_PREVIEW_PROCESS_DOCKER_TEST === '1',
  'NS_MULTITENANT_PREVIEW_PROCESS_DOCKER_TEST=1')(
  'executable nightscout multitenant api preview (owned PostgreSQL/Vault)', function () {
    this.timeout(120000);
    const fixture = createFixture();
    const [A, B] = fixture.tenants;
    const SUBJECT = '000000000000000000000001';
    const { stop, ready, http, exchange, localToken } = fixture;
    const controls = { NODE_OPTIONS: process.env.NODE_OPTIONS, NS_PREVIEW_PROCESS_CONTROL: process.env.NS_PREVIEW_PROCESS_CONTROL };
    const start = settings => fixture.start(undefined, { ...controls, ...settings });
    const refused = (settings, options) => fixture.refused(undefined, { ...controls, ...settings }, options);
    let admin;
    before(async function () {
      await fixture.setup();
      admin = fixture.admin;
    });
    after(() => fixture.cleanup());
    afterEach(async function () {
      for (const worker of fixture.workers) {
        if (!worker.exit) worker.child.kill('SIGTERM');
        await worker.exited;
        fixture.workers.delete(worker);
      }
    });

    async function assertPoolsClosed () {
      const sessions = await admin.query('SELECT usename FROM pg_stat_activity WHERE usename = ANY($1)', [Object.values(fixture.platform.roles)]);
      assert.deepEqual(sessions.rows, [], 'role shutdown releases every application pool');
    }

    it('data JWT actual API reads and writes use derived keys and current PostgreSQL across processes', async function () {
      const first = start(), second = start();
      await ready(first); await ready(second);
      const a = await localToken(A), b = await localToken(B);
      const auditBefore = Number((await admin.query('SELECT count(*) FROM preview_secrets.secret_audit')).rows[0].count);
      for (const worker of [first, second]) {
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries', a)).status, 200);
        assert.equal((await http(worker, B, 'GET', '/api/v3/entries', b)).status, 200);
        const write = await http(worker, A, 'POST', '/api/v3/entries', a, {
          identifier: 'local-' + worker.port, date: 1793664000000, utcOffset: 0, type: 'sgv', sgv: 140, app: 'synthetic-local'
        });
        assert.equal(write.status, 201, JSON.stringify(write.body));
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries/local-' + worker.port, a)).body.result.subject, 'Synthetic Viewer 0');
        assert.equal((await http(worker, A, 'PATCH', '/api/v3/entries/local-' + worker.port, a, { sgv: 143 })).status, 200);
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries/local-' + worker.port, a)).body.result.modifiedBy, 'Synthetic Viewer 0');
        const foreign = await http(worker, B, 'GET', '/api/v3/entries', a);
        assert.equal(foreign.status, 401, 'a data JWT for A fails signature and tenant checks on B (D14)');
        assert.equal((await http(worker, A, 'GET', '/api/v1/entries', a)).status, 200);
        assert.equal((await http(worker, A, 'GET', '/api/v2/authorization/permissions', a)).status, 401);
      }
      assert.equal(Number((await admin.query('SELECT count(*) FROM preview_secrets.secret_audit')).rows[0].count), auditBefore,
        'data JWT requests must never call the audited secrets component');
      const exchanged = await exchange(first, A);
      assert.equal(exchanged.status, 200); assert.equal(exchanged.body.exp - exchanged.body.iat, 28800);
      assert.equal((await http(first, A, 'GET', '/api/v3/entries', exchanged.body.token)).status, 200);
      await stop(first); await stop(second);
    });

    it('data JWT signature, audience, tenant, kid and expiry controls refuse before any handler effect', async function () {
      const worker = start(); await ready(worker);
      const token = await localToken(A), parts = token.split('.');
      const signature = Buffer.from(parts[2], 'base64url'); signature[0] ^= 1;
      parts[2] = signature.toString('base64url');
      const invalid = [parts.join('.'), await localToken(A, { aud: 'wrong-audience' }),
        await localToken(A, { purpose: 'management' }), await localToken(A, { tid: B }),
        await localToken(A, {}, { kid: 'unknown' }), await localToken(A, { exp: Math.floor(Date.now() / 1000) - 1 })];
      for (const credential of invalid) {
        const result = await http(worker, A, 'POST', '/api/v3/entries', credential, {
          identifier: 'must-not-write-local', date: 1793664000000, utcOffset: 0, type: 'sgv', sgv: 999, app: 'synthetic-local'
        });
        assert.equal(result.status, 401, 'invalid new token must refuse: ' + JSON.stringify(result.body));
      }
      assert.equal((await admin.query("SELECT count(*)::int n FROM preview_entries.entries WHERE doc->>'identifier'='must-not-write-local'")).rows[0].n, 0);
      await stop(worker);
    });

    // Decision deployment-signing-secret: the data JWT is revoked by the subject's
    // credential version, the tenant's root version and the data key row; the
    // retired ns-access sessions and credentials no longer apply to DATA.
    it('data JWT same-token grant and credential revocation are current across independent API processes', async function () {
      const first = start(), second = start();
      await ready(first); await ready(second);
      const token = await localToken(A);
      for (const worker of [first, second]) assert.equal((await http(worker, A, 'GET', '/api/v3/entries', token)).status, 200);
      await admin.query('BEGIN');
      await admin.query("UPDATE preview_authorization.tenant_authorization_roles SET permissions=ARRAY['denied'] WHERE tenant_id=$1", [A]);
      assert.equal((await http(second, A, 'GET', '/api/v3/entries', token)).status, 200);
      await admin.query('COMMIT');
      try {
        for (const worker of [first, second]) assert.equal((await http(worker, A, 'GET', '/api/v3/entries', token)).status, 403);
      } finally {
        await admin.query("UPDATE preview_authorization.tenant_authorization_roles SET permissions=ARRAY['api:entries:read','api:entries:create','api:entries:update'] WHERE tenant_id=$1", [A]);
      }
      for (const [table, change, restore, where] of [
        ['legacy_credential_subjects', 'credential_version=2', 'credential_version=1', ' AND subject_id=$2'],
        ['legacy_credential_config', 'root_version=2', 'root_version=1', ''],
        ['legacy_data_keys', 'active=false, signing=false', 'active=true, signing=true', " AND kid='data-1'"]
      ]) {
        const values = where.includes('$2') ? [A, SUBJECT] : [A];
        for (const worker of [first, second]) assert.equal((await http(worker, A, 'GET', '/api/v3/entries', token)).status, 200);
        await admin.query('UPDATE preview_legacy.' + table + ' SET ' + change + ' WHERE tenant_id=$1' + where, values);
        try {
          for (const worker of [first, second]) {
            assert.equal((await http(worker, A, 'GET', '/api/v3/entries', token)).status, 401, table);
            assert.equal((await http(worker, A, 'POST', '/api/v3/entries', token, {
              identifier: 'local-revoked-' + table, date: 1793664000000, utcOffset: 0, type: 'sgv', sgv: 999, app: 'synthetic-local'
            })).status, 401, table + ' write');
          }
          assert.equal((await admin.query("SELECT count(*)::int n FROM preview_entries.entries WHERE doc->>'identifier'=$1", ['local-revoked-' + table])).rows[0].n, 0);
        } finally { await admin.query('UPDATE preview_legacy.' + table + ' SET ' + restore + ' WHERE tenant_id=$1' + where, values); }
      }
      await stop(first); await stop(second);
    });

    it('data JWT preserves default-role validation from the current authority', async function () {
      const worker = start(); await ready(worker);
      const local = await localToken(A), exchanged = (await exchange(worker, A)).body.token;
      await admin.query("UPDATE preview_authorization.tenant_authorization_config SET anonymous_roles=ARRAY['readable','readable'] WHERE tenant_id=$1", [A]);
      try {
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries', exchanged)).status, 503, 'existing authority rejects malformed defaults');
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries', local)).status, 503, 'new snapshot must reject malformed defaults too');
      } finally { await admin.query("UPDATE preview_authorization.tenant_authorization_config SET anonymous_roles=ARRAY['denied'] WHERE tenant_id=$1", [A]); }
      await stop(worker);
    });

    it('data JWT preserves incomplete-name reads and refuses unattributed writes', async function () {
      const worker = start(); await ready(worker);
      const local = await localToken(A), exchanged = (await exchange(worker, A)).body.token;
      assert.equal((await http(worker, A, 'POST', '/api/v3/entries', local, {
        identifier: 'local-null-name', date: 1793664000000, utcOffset: 0, type: 'sgv', sgv: 145, app: 'synthetic-local'
      })).status, 201);
      await admin.query('UPDATE preview_authorization.tenant_authorization_subjects SET display_name=NULL WHERE tenant_id=$1', [A]);
      try {
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries/local-null-name', exchanged)).status, 200, 'existing read allows incomplete name metadata');
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries/local-null-name', local)).status, 200, 'new read preserves this metadata behavior');
        for (const credential of [exchanged, local]) assert.equal((await http(worker, A, 'PATCH', '/api/v3/entries/local-null-name', credential, { sgv: 999 })).status, 401);
        const stored = await admin.query("SELECT doc FROM preview_entries.entries WHERE tenant_id=$1 AND doc->>'identifier'='local-null-name'", [A]);
        assert.equal(stored.rows[0].doc.sgv, 145);
      } finally { await admin.query("UPDATE preview_authorization.tenant_authorization_subjects SET display_name='Synthetic Viewer 0' WHERE tenant_id=$1", [A]); }
      await stop(worker);
    });

    it('the registry rejects sharing a tenant signing key at the PostgreSQL write boundary', async function () {
      const keys = 'preview_registry.tenant_registry_keys';
      await assert.rejects(admin.query(`UPDATE ${keys} SET public_key =
        (SELECT public_key FROM ${keys} WHERE tenant_id=$1 AND purpose='management')
        WHERE tenant_id=$2 AND purpose='management'`, [A, B]), { code: '23505' });
      const worker = start(); await ready(worker);
      for (const tenant of [A, B]) {
        assert.equal((await http(worker, tenant, 'GET', '/api/v3/entries', await localToken(tenant))).status, 200);
      }
      await stop(worker);
    });

    it('serves data JWTs (fixture-signed and exchanged) during Vault outage and refuses an unavailable PostgreSQL authority', async function () {
      const worker = start(); await ready(worker);
      const token = await localToken(A), exchanged = await exchange(worker, A);
      assert.equal(exchanged.status, 200);
      await fixture.whilePaused('vault', async () => {
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries', token)).status, 200);
        assert.equal((await http(worker, A, 'POST', '/api/v3/entries', token, {
          identifier: 'local-vault-down', date: 1793664000000, utcOffset: 0, type: 'sgv', sgv: 142, app: 'synthetic-local'
        })).status, 201);
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries', exchanged.body.token)).status, 200);
        await admin.query('UPDATE preview_legacy.legacy_credential_subjects SET credential_version=2 WHERE tenant_id=$1 AND subject_id=$2', [A, SUBJECT]);
        try { assert.equal((await http(worker, A, 'GET', '/api/v3/entries', token)).status, 401); }
        finally { await admin.query('UPDATE preview_legacy.legacy_credential_subjects SET credential_version=1 WHERE tenant_id=$1 AND subject_id=$2', [A, SUBJECT]); }
      });
      assert.equal((await http(worker, A, 'GET', '/api/v3/entries', token)).status, 200, 'established registry tenant is admitted immediately before PostgreSQL outage');
      process.stdout.write('PREVIEW_OUTAGE_STAGE PG_PREWARM_CONFIRMED\n');
      await fixture.whilePaused('postgres', async () => {
        process.stdout.write('PREVIEW_OUTAGE_STAGE PG_GET_STARTED\n');
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries', token)).status, 503);
        process.stdout.write('PREVIEW_OUTAGE_STAGE PG_GET_REFUSED_POST_STARTED\n');
        assert.equal((await http(worker, A, 'POST', '/api/v3/entries', token, {
          identifier: 'local-pg-down', date: 1793664000000, utcOffset: 0, type: 'sgv', sgv: 999, app: 'synthetic-local'
        })).status, 503);
      });
      process.stdout.write('PREVIEW_OUTAGE_STAGE PG_RESTORED\n');
      assert.equal((await http(worker, A, 'GET', '/api/v3/entries/local-pg-down', token)).status, 404);
      await stop(worker);
    });

    it('runs the executable with no single secrets/Mongo and preserves tenant writes across process restart', async function () {
      const first = start();
      await ready(first);
      const credentials = [];
      for (const [i, tenant] of [A, B].entries()) {
        const result = await exchange(first, tenant);
        assert.equal(result.status, 200);
        assert.equal(result.body.exp - result.body.iat, 28800);
        credentials[i] = result.body.token;
        const write = await http(first, tenant, 'POST', '/api/v3/entries', credentials[i],
          { identifier: 'shared-entry', type: 'sgv', date: 1700000000000, utcOffset: 0,
            app: 'synthetic-preview', sgv: 101 + i });
        assert.equal(write.status, 201, JSON.stringify(write.body));
      }
      assert.equal((await http(first, B, 'POST', '/api/v3/entries', credentials[0],
        { identifier: 'foreign-write', type: 'sgv', date: 1700000000001, utcOffset: 0,
          app: 'synthetic-preview', sgv: 999 })).status, 401);
      await stop(first);
      const second = start();
      await ready(second);
      for (const [i, tenant] of [A, B].entries()) {
        const read = await http(second, tenant, 'GET', '/api/v3/entries/shared-entry', credentials[i]);
        assert.equal(read.status, 200);
        assert.equal(read.body.result.sgv, 101 + i);
        const search = await http(second, tenant, 'GET', '/api/v3/entries?sgv$eq=' + (101 + i), credentials[i]);
        assert.equal(search.status, 200);
        assert.equal(search.body.result.length, 1);
      }
      assert.equal((await http(second, B, 'GET', '/api/v3/entries/foreign-write', credentials[1])).status, 404);
      assert.equal((await http(second, A, 'GET', '/api/v3/entries', credentials[0], undefined, { Host: 'unknown.example.test' })).status, 404);
      assert.equal((await http(second, A, 'GET', '/api/v3/entries', credentials[0], undefined, { 'X-Forwarded-Host': 'one.example.test' })).status, 400);
      for (const management of ['/api/v1/tenant/settings', '/api/v1/operator/tenants/' + A + '/policy']) {
        assert.equal((await http(second, A, 'GET', management, credentials[0])).status, 404);
      }
      await admin.query("UPDATE preview_authorization.tenant_authorization_roles SET permissions = ARRAY['denied'] WHERE tenant_id = $1", [A]);
      try {
        assert.equal((await http(second, A, 'GET', '/api/v3/entries', credentials[0])).status, 403);
      } finally {
        await admin.query(`UPDATE preview_authorization.tenant_authorization_roles SET permissions =
          ARRAY['api:entries:read','api:entries:create','api:entries:update'] WHERE tenant_id = $1`, [A]);
      }
      await fixture.whilePaused('vault', async () => {
        assert.equal((await http(second, B, 'GET', '/api/v3/entries', credentials[1])).status, 200);
      });
      assert.equal((await http(second, B, 'GET', '/api/v3/entries', credentials[1])).status, 200);
      await stop(second);
      await assertPoolsClosed();
    });

    it('runs entries replace, PATCH, logical delete, history and permanent delete through the executable', async function () {
      const baseGrants = ['api:entries:read', 'api:entries:create', 'api:entries:update'];
      const worker = start();
      await ready(worker);
      const credentials = [];
      for (const [i, tenant] of [A, B].entries()) {
        const exchanged = await exchange(worker, tenant);
        assert.equal(exchanged.status, 200);
        credentials[i] = exchanged.body.token;
        const created = await http(worker, tenant, 'POST', '/api/v3/entries', credentials[i], {
          identifier: 'crud-overlap', type: 'sgv', date: 1793664000000,
          utcOffset: 0, app: 'synthetic-crud', sgv: 111 + i
        });
        assert.equal(created.status, 201, JSON.stringify(created.body));
      }

      const rows = async tenant => (await admin.query(
        `SELECT doc FROM preview_entries.entries WHERE tenant_id = $1 AND doc->>'identifier' = $2`,
        [tenant, 'crud-overlap'])).rows.map(row => row.doc);
      const changeGrants = permissions => admin.query(
        'UPDATE preview_authorization.tenant_authorization_roles SET permissions = $1 WHERE tenant_id = $2 AND name = $3',
        [permissions, A, 'viewer']);
      const originalA = await rows(A);
      const originalB = await rows(B);
      assert.equal(originalA.length, 1);
      assert.equal(originalB.length, 1);
      if (process.env.NS_PREVIEW_PROCESS_CONTROL === 'intent') {
        const failedMutation = await http(worker, A, 'PATCH', '/api/v3/entries/crud-overlap',
          credentials[0], { sgv: 125 });
        assert.equal(failedMutation.status, 500);
        assert.deepEqual(await rows(A), originalA);
        return;
      }

      try {
        await changeGrants(['api:entries:read', 'api:entries:create']);
        const deniedReplace = await http(worker, A, 'PUT', '/api/v3/entries/crud-overlap',
          credentials[0], { identifier: 'body-identifier-is-ignored', type: 'sgv', date: 1793664000000,
            utcOffset: 0, app: 'synthetic-crud', sgv: 120 });
        assert.equal(deniedReplace.status, 403);
        assert.deepEqual(await rows(A), originalA);

        await changeGrants(baseGrants);
        const replaced = await http(worker, A, 'PUT', '/api/v3/entries/crud-overlap',
          credentials[0], { identifier: 'body-identifier-is-ignored', type: 'sgv', date: 1793664000000,
            utcOffset: 0, app: 'synthetic-crud', sgv: 121 });
        assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
        assert.ok(replaced.headers['last-modified']);
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries/crud-overlap', credentials[0])).body.result.sgv, 121);
        assert.equal((await http(worker, B, 'GET', '/api/v3/entries/crud-overlap', credentials[1])).body.result.sgv, 112);

        const patched = await http(worker, A, 'PATCH', '/api/v3/entries/crud-overlap', credentials[0],
          { sgv: 122, extension: { retained: true } });
        assert.equal(patched.status, 200, JSON.stringify(patched.body));
        const afterPatch = (await rows(A))[0];
        assert.equal(afterPatch.identifier, 'crud-overlap');
        assert.equal(afterPatch.sgv, 122);
        assert.deepEqual(afterPatch.extension, { retained: true });
        assert.equal(afterPatch.modifiedBy, 'Synthetic Viewer 0');
        assert.deepEqual(await rows(B), originalB);

        await admin.query('UPDATE preview_authorization.tenant_authorization_subjects SET display_name = NULL WHERE tenant_id = $1 AND subject_id = $2',
          [A, SUBJECT]);
        try {
          const missingName = await http(worker, A, 'PATCH', '/api/v3/entries/crud-overlap', credentials[0], { sgv: 123 });
          assert.equal(missingName.status, 401);
          assert.deepEqual(await rows(A), [afterPatch]);
        } finally {
          await admin.query('UPDATE preview_authorization.tenant_authorization_subjects SET display_name = $1 WHERE tenant_id = $2 AND subject_id = $3',
            ['Synthetic Viewer 0', A, SUBJECT]);
        }
        assert.equal((await http(worker, A, 'PATCH', '/api/v3/entries/crud-overlap', undefined, { sgv: 123 })).status, 403);
        assert.equal((await http(worker, B, 'PATCH', '/api/v3/entries/crud-overlap', credentials[0], { sgv: 123 })).status, 401);

        const deniedDelete = await http(worker, A, 'DELETE', '/api/v3/entries/crud-overlap', credentials[0]);
        assert.equal(deniedDelete.status, 403);
        assert.deepEqual(await rows(A), [afterPatch]);
        await changeGrants([...baseGrants, 'api:entries:delete']);

        const logicalDelete = await http(worker, A, 'DELETE', '/api/v3/entries/crud-overlap', credentials[0]);
        assert.equal(logicalDelete.status, 200, JSON.stringify(logicalDelete.body));
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries/crud-overlap', credentials[0])).status, 410);
        const history = await http(worker, A, 'GET', '/api/v3/entries/history/1793664000000', credentials[0]);
        assert.equal(history.status, 200, JSON.stringify(history.body));
        const tombstone = history.body.result.find(entry => entry.identifier === 'crud-overlap');
        assert.ok(tombstone);
        assert.equal(tombstone.isValid, false);
        assert.equal((await http(worker, B, 'GET', '/api/v3/entries/crud-overlap', credentials[1])).body.result.sgv, 112);

        const permanentDelete = await http(worker, A, 'DELETE', '/api/v3/entries/crud-overlap?permanent=true', credentials[0]);
        assert.equal(permanentDelete.status, 200, JSON.stringify(permanentDelete.body));
        assert.deepEqual(await rows(A), []);
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries/crud-overlap', credentials[0])).status, 404);
        const historyAfterPermanentDelete = await http(worker, A, 'GET',
          '/api/v3/entries/history/1793664000000', credentials[0]);
        assert.equal(historyAfterPermanentDelete.status, 200);
        assert.equal(historyAfterPermanentDelete.body.result.some(entry => entry.identifier === 'crud-overlap'), false);
        assert.deepEqual(await rows(B), originalB);
      } finally {
        await changeGrants(baseGrants);
        await admin.query('UPDATE preview_authorization.tenant_authorization_subjects SET display_name = $1 WHERE tenant_id = $2 AND subject_id = $3',
          ['Synthetic Viewer 0', A, SUBJECT]);
      }

      await stop(worker);
      const restarted = start();
      await ready(restarted);
      assert.equal((await http(restarted, A, 'GET', '/api/v3/entries/crud-overlap', credentials[0])).status, 404);
      const restartedHistory = await http(restarted, A, 'GET',
        '/api/v3/entries/history/1793664000000', credentials[0]);
      assert.equal(restartedHistory.status, 200);
      assert.equal(restartedHistory.body.result.some(entry => entry.identifier === 'crud-overlap'), false);
      assert.equal((await http(restarted, B, 'GET', '/api/v3/entries/crud-overlap', credentials[1])).body.result.sgv, 112);
      await stop(restarted);
    });

    it('serves legacy and API3 domains with real snapshots and tenant-local authority', async function () {
      await admin.query("UPDATE preview_authorization.tenant_authorization_roles SET permissions = ARRAY['*']");
      const worker = start();
      try {
        await ready(worker);
        const credentials = [];
        for (const tenant of [A, B]) credentials.push((await exchange(worker, tenant)).body.token);
        const id = '000000000000000000000901';
        const now = Date.now(), created_at = new Date(now).toISOString();
        const bodies = {
          entries: { _id: id, date: now, dateString: created_at, type: 'sgv', sgv: 141 },
          treatments: { _id: id, created_at, eventType: 'Note', carbs: 15, notes: 'synthetic' },
          devicestatus: { _id: id, created_at, date: now, device: 'synthetic', uploader: { battery: 75 } },
          profile: { _id: id, startDate: created_at, store: { Default: { basal: [{ time: '00:00', value: 1 }] } } },
          food: { _id: id, name: 'synthetic', carbs: 10, portion: 1, unit: 'g' },
          activity: { _id: id, created_at, steps: 10 }
        };
        for (const [i, tenant] of [A, B].entries()) {
          for (const [logical, body] of Object.entries(bodies)) {
            const result = await http(worker, tenant, 'POST', '/api/v' + (i + 1) + '/' + logical,
              credentials[i], { ...body, tenantMarker: i });
            assert.equal(result.status, 200, logical + ': ' + JSON.stringify(result.body));
            const listed = await http(worker, tenant, 'GET', '/api/v2/' + logical, credentials[i]);
            assert.equal(listed.status, 200, logical + ': ' + JSON.stringify(listed.body));
            assert.ok(listed.body.some(doc => doc.tenantMarker === i), logical + ' legacy snapshot isolation');
            if (logical !== 'activity') {
              const read = await http(worker, tenant, 'GET', '/api/v3/' + logical + '/' + id, credentials[i]);
              assert.equal(read.status, 200, logical + ': ' + JSON.stringify(read.body));
              assert.equal(read.body.result.tenantMarker, i);
              const history = await http(worker, tenant, 'GET', '/api/v3/' + logical + '/history/' + (now - 1000), credentials[i]);
              assert.equal(history.status, 200);
              assert.ok(history.body.result.some(doc => doc.tenantMarker === i));
            }
            const options = await http(worker, tenant, 'OPTIONS', '/api/v2/' + logical, credentials[i]);
            assert.equal(options.status, 200, logical);
            assert.match(options.headers.allow, /GET/);
          }
          const settings = await http(worker, tenant, 'POST', '/api/v3/settings', credentials[i],
            { identifier: 'overlapping-settings', date: now, utcOffset: 0, app: 'synthetic', marker: i });
          assert.equal(settings.status, 201, JSON.stringify(settings.body));
          assert.equal((await http(worker, tenant, 'GET', '/api/v3/settings/overlapping-settings',
            credentials[i])).body.result.marker, i);
          for (const resource of ['/api/v1/status', '/api/v2/verifyauth', '/api/v2/authorization/permissions',
            '/api/v3/status', '/api/v3/version', '/api/v3/lastModified', '/api/versions']) {
            const result = await http(worker, tenant, 'GET', resource, credentials[i]);
            assert.equal(result.status, 200, resource + ': ' + JSON.stringify(result.body));
          }
          assert.equal((await http(worker, tenant, 'HEAD', '/api/v2/entries', credentials[i])).status, 200);
          assert.equal((await http(worker, tenant, 'PUT', '/api/v1/entries', credentials[i], bodies.entries)).status, 405);
          assert.equal((await http(worker, tenant, 'GET', '/api/v3/activity', credentials[i])).status, 405);
          const summary = await http(worker, tenant, 'GET', '/api/v2/summary', credentials[i]);
          assert.equal(summary.status, 200);
          assert.ok(summary.body.sgvs.some(reading => reading.sgv === 141));
          assert.equal((await http(worker, tenant, 'GET', '/api/v1/summary', credentials[i])).status, 405);
          assert.equal((await http(worker, tenant, 'POST', '/api/v2/summary', credentials[i], {})).status, 405);
        }
        // Raw entry frames read the entries backend, independently of activity.
        const entryCount = async () => (await admin.query('SELECT count(*)::int AS n FROM preview_entries.entries WHERE tenant_id=$1', [A])).rows[0].n;
        const entriesBeforeFault = await entryCount();
        await admin.query(`REVOKE SELECT ON preview_entries.entries FROM ${fixture.platform.roles.api}`);
        try {
          const unavailable = await http(worker, A, 'GET', '/api/v1/entries', credentials[0]);
          assert.equal(unavailable.status, 503);
          assert.deepEqual(unavailable.body, { error: 'TENANT_SNAPSHOT_UNAVAILABLE' });
        } finally { await admin.query(`GRANT SELECT ON preview_entries.entries TO ${fixture.platform.roles.api}`); }
        await admin.query('ALTER TABLE preview_entries.entries RENAME TO entries_fault_fixture');
        try {
          const failed = await http(worker, A, 'GET', '/api/v2/entries', credentials[0]);
          assert.equal(failed.status, 500);
          assert.deepEqual(failed.body, { error: 'TENANT_SNAPSHOT_INTERNAL' });
        } finally { await admin.query('ALTER TABLE preview_entries.entries_fault_fixture RENAME TO entries'); }
        assert.equal(await entryCount(), entriesBeforeFault, 'read backend faults have no clinical write effect');
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries/' + id, credentials[0])).status, 200, 'restored entry backend serves addressed reads');
        assert.equal((await http(worker, B, 'GET', '/api/v2/entries', credentials[0])).status, 401);
        await admin.query("UPDATE preview_authorization.tenant_authorization_roles SET permissions = ARRAY['denied'] WHERE tenant_id=$1", [A]);
        assert.equal((await http(worker, A, 'POST', '/api/v1/entries', credentials[0], bodies.entries)).status, 401);
      } finally {
        if (worker.port) await stop(worker);
        await admin.query(`UPDATE preview_authorization.tenant_authorization_roles SET permissions =
          ARRAY['api:entries:read','api:entries:create','api:entries:update']`);
      }
    });

    it('reads tenant-specific display units through the common legacy status parent', async function () {
      await admin.query("UPDATE preview_authorization.tenant_authorization_roles SET permissions = ARRAY['*']");
      const worker = start();
      try {
        await ready(worker);
        const credential = (await exchange(worker, A)).body.token;
        const status = await http(worker, A, 'GET', '/api/v2/status.json', credential);
        assert.equal(status.status, 200);
        assert.equal((await http(worker, A, 'GET', '/api/v1/status?count=invalid', credential)).status, 400);
        assert.equal(status.body.settings.units, 'mg/dl');
        await admin.query('UPDATE preview_display_settings.tenant_settings SET version=version+1, values=$2 WHERE tenant_id=$1',
          [A, { DISPLAY_UNITS: 'mmol' }]);
        const changed = await http(worker, A, 'GET', '/api/v2/status.json', credential);
        assert.equal(changed.status, 200);
        assert.equal(changed.body.settings.units, 'mmol');
        const other = await http(worker, B, 'GET', '/api/v2/status.json', (await exchange(worker, B)).body.token);
        assert.equal(other.status, 200);
        assert.equal(other.body.settings.units, 'mg/dl');
        const raw = fixture.subjectCredential(A);
        const issued = await http(worker, A, 'GET', '/api/v2/status.json?token=' + raw);
        assert.equal(issued.status, 200);
        assert.equal(issued.body.authorized.sub, 'Synthetic Viewer 0');
      } finally {
        await admin.query("UPDATE preview_display_settings.tenant_settings SET version=version+1, values='{}' WHERE tenant_id=$1", [A]);
        if (worker.port) await stop(worker);
        await admin.query(`UPDATE preview_authorization.tenant_authorization_roles SET permissions =
          ARRAY['api:entries:read','api:entries:create','api:entries:update']`);
      }
    });

    it('refuses invalid deployment settings and unsafe database logins before binding', async function () {
      for (const [settings, expected] of [
        [{ NS_VAULT_ADDR: '' }, /NS_VAULT_ADDR/],
        [{ NS_PG_PREFIX: 'invalid-prefix' }, /NS_PG_PREFIX/],
        [{ NS_API_PG: '' }, /credential environment reference is missing/],
        [{ NS_READINESS_PG: fixture.platform.urls.api }, /separate serving/],
        [{ NS_TENANT_RESOLUTION: 'canonical-internal' }, /allowlist/],
        [{ NS_VAULT_ALLOW_INSECURE_LOOPBACK: 'false' }, /provider or ingress configuration/]
      ]) {
        const worker = await refused(settings);
        assert.match(worker.stderr, expected);
      }
      await refused({ NS_API_PG: fixture.adminConnectionString }, { code: 1 });
    });

    it('refuses a wrong backend catalogue before the preview listener binds', async function () {
      // The child's catalogue differs from the applied ledger: its own start
      // check finds the ledger not current for that catalogue.
      await refused({
        NODE_OPTIONS: '--require=' + path.join(__dirname, 'fixtures/preview-composition-control.cjs'),
        NS_PREVIEW_COMPOSITION_FAULT: 'catalogue'
      }, { code: 1 });
    });

    it('cleans acquired pools after late initialization or listener failure', async function () {
      const stale = await admin.query('DELETE FROM preview_authorization.schema_migrations WHERE name = (SELECT max(name) FROM preview_authorization.schema_migrations) RETURNING name, checksum');
      try { await refused({}, { code: 1 }); } finally {
        await admin.query('INSERT INTO preview_authorization.schema_migrations(name,checksum) VALUES($1,$2)', [stale.rows[0].name, stale.rows[0].checksum]);
      }
      const occupied = net.createServer();
      occupied.listen(0, '127.0.0.1');
      await once(occupied, 'listening');
      try {
        const worker = start({ API_PORT: String(occupied.address().port) });
        assert.deepEqual(await worker.exited, { code: 1, signal: null });
        assert.doesNotMatch(worker.stderr, /postgres:|password|vault:/i);
        fixture.workers.delete(worker);
      } finally { await new Promise(resolve => occupied.close(resolve)); }
      await assertPoolsClosed();
    });

    it('requires an explicitly allowlisted immediate peer even for Host-only canonical requests', async function () {
      for (const [i, tenant] of [A, B].entries()) await admin.query(
        'INSERT INTO preview_registry.tenant_registry_hosts(host,tenant_id,kind) VALUES($1,$2,$3)',
        ['tenant-' + i + '.internal.test', tenant, 'internal']);
      async function listen (trustedPeer) {
        const worker = start({ NS_TENANT_RESOLUTION: 'canonical-internal', NS_TRUSTED_PEERS: trustedPeer });
        await fixture.until(async () => {
          assert.equal(worker.exit, null, worker.stderr);
          const found = /Listening for role api on 127\.0\.0\.1:(\d+)/.exec(worker.stdout);
          if (!found) return false;
          worker.port = Number(found[1]);
          return true;
        }, 'canonical preview listener');
        return worker;
      }
      const worker = await listen('127.0.0.1');
      const credential = fixture.subjectCredential(A);
      assert.equal((await http(worker, A, 'GET', '/api/v3/entries', undefined, undefined,
        { Host: 'tenant-0.internal.test' })).status, 403);
      const response = await http(worker, A, 'GET', '/api/v2/authorization/request/' + credential, undefined, undefined,
        { Host: 'tenant-0.internal.test', 'X-Forwarded-Host': 'disposable.example.test' });
      assert.equal(response.status, 200);
      await stop(worker);
      const untrusted = await listen('127.0.0.2');
      assert.equal((await http(untrusted, A, 'GET', '/api/v3/entries', undefined, undefined,
        { Host: 'tenant-0.internal.test' })).status, 400);
      assert.equal((await http(untrusted, A, 'GET', '/api/v3/entries', response.body.token, undefined,
        { Host: 'tenant-0.internal.test', 'X-Forwarded-For': '127.0.0.2' })).status, 400);
      await stop(untrusted);
    });
  });
