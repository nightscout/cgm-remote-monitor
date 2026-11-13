'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
module.exports = async function readerGrants ({ config, owned, captureDir, env }) {
  const selected = require('./roles').roleEnvironment(JSON.parse(fs.readFileSync(config.realtimeEnvFile, 'utf8')), env);
  const document = JSON.parse(fs.readFileSync(selected.MULTITENANT_REALTIME_CONFIG, 'utf8'));
  const connectionString = selected[document.postgres.connectionEnv]; assert(connectionString);
  const { Client } = require('pg'), connection = new Client({ connectionString }); const results = [];
  try {
    await connection.connect();
    for (const logical of ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity']) {
      const namespace = document.postgres.namespaces[logical]; assert.match(namespace, /^[a-z][a-z0-9_]{0,62}$/);
      assert.equal(owned.namespaces[logical], namespace);
      let refusal;
      await connection.query('BEGIN');
      try {
        await connection.query("SELECT set_config('app.current_tenant_id',$1,true)", [config.tenant]);
        await connection.query('INSERT INTO "' + namespace + '"."' + logical + '"(tenant_id,id_kind,doc) VALUES($1,$2,$3::jsonb)',
          [config.tenant, 'string', JSON.stringify({ _id: 'synthetic-forbidden-' + require('node:crypto').randomUUID() })]);
      } catch (error) { refusal = error.code; }
      finally { await connection.query('ROLLBACK'); }
      results.push({ logical, refusal });
      fs.writeFileSync(require('node:path').join(captureDir, 'realtime-reader-denials.json'), JSON.stringify(results, null, 2) + '\n');
      assert.equal(refusal, '42501', 'RT_CLINICAL_WRITE_DENIED actual role must lack ' + logical + ' INSERT');
    }
  } finally { await connection.end(); }
  fs.writeFileSync(require('node:path').join(captureDir, 'realtime-reader-denials.json'), JSON.stringify(results, null, 2) + '\n');
};
