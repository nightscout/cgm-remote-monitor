'use strict';
// Actual owned SQL writer used only by the SQL-core fixture. It is not an API,
// uploader or serving-process substitute. Parent records birth before SIGSTOP.
const { Client } = require('pg');
async function main () {
  const [namespace, tenant] = process.argv.slice(2);
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(namespace || '') || !/^[a-f0-9-]{36}$/.test(tenant || '')) throw new Error('WHOLE_C_WRITER_INPUT');
  const client = new Client({ connectionString: process.env.NS_WHOLE_C_WRITER_URI, statement_timeout: 5000 });
  await client.connect();
  const write = async () => {
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
      const result = await client.query('UPDATE "' + namespace + '".tenant_write_clock SET last_stamp=last_stamp+1 WHERE tenant_id=$1 RETURNING last_stamp', [tenant]);
      if (result.rowCount !== 1) throw new Error('WHOLE_C_WRITER_NO_EFFECT');
      await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  };
  await write(); process.send({ type: 'ready' });
  let chain = Promise.resolve();
  const timer = setInterval(() => { chain = chain.then(write).catch(error => { process.send({ type: 'error', code: error.code || 'WRITE' }); process.exitCode = 1; }); }, 100);
  process.on('message', async message => {
    if (message?.type !== 'drain') return;
    clearInterval(timer); await chain; await client.end();
    process.send({ type: 'drained' });
    setInterval(() => {}, 1000); // Hold the actual birth for independently observed SIGSTOP.
  });
}
main().catch(error => { if (process.send) process.send({ type: 'error', code: error.code || 'START' }); process.exitCode = 1; });
