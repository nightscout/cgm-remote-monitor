'use strict';
// Separate, read-only raw SQL observer process; immutable under source controls.
const { Client } = require('pg');
const { physical } = require('./oracle');
async function main () {
  const prefix = process.env.NS_WHOLE_C_PREFIX;
  if (!/^wc_[a-f0-9]{12}$/.test(prefix || '')) throw new Error('WHOLE_C_OBSERVER_PREFIX');
  const client = new Client({ connectionString: process.env.NS_WHOLE_C_OBSERVER_URI, application_name: prefix + '_observer', statement_timeout: 15000 });
  await client.connect(); process.send({ type: 'ready' });
  process.on('message', async message => {
    if (message.type === 'close') { await client.end(); process.disconnect(); return; }
    if (message.type !== 'physical' || !Array.isArray(message.catalogues) || message.catalogues.some(entry => !entry.namespace.startsWith(prefix + '_'))) throw new Error('WHOLE_C_OBSERVER_OWNERSHIP');
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const value = await physical(client, message.catalogues);
      await client.query('COMMIT'); process.send({ type: 'physical', id: message.id, value });
    } catch (error) { await client.query('ROLLBACK'); process.send({ type: 'failure', id: message.id, code: error.code || 'OBSERVER' }); }
  });
}
main().catch(error => { if (process.send) process.send({ type: 'failure', code: error.code || 'OBSERVER_START' }); process.exitCode = 1; });
