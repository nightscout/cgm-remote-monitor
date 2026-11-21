'use strict';

// Only the disposable test fixture starts this process. Configuration is passed
// privately through its environment and is never written to logs or argv.
const connect = require('../../lib/storage/postgres-connection');
const decorate = require('../../lib/storage/postgres-write-clock');
const scope = require('../../lib/storage/tenant-scope');
const createPort = require('../../lib/storage/postgres-entries-intent');
const { EventEmitter } = require('node:events');
const { INTENT_EVENT } = require('../../lib/storage/write-intent');

async function main () {
  const config = JSON.parse(process.env.NS_REPLAY_WRITER_CONFIG);
  delete process.env.NS_REPLAY_WRITER_CONFIG;
  scope.setTenancyMode('multi');
  const raw = await connect({ connectionString: config.connectionString, max: 1 });
  const clock = decorate(raw, config.clockNamespace);
  const bus = new EventEmitter();
  bus.on(INTENT_EVENT, () => process.send({ unexpectedPublish: true }));
  const step = createPort({ connection: clock, table: config.table, bus });
  try {
    await scope.withTenant(config.tenant, () => clock.transaction(async () => {
      // Registered first: COMMIT is acknowledged, but the intent's subsequent
      // afterCommit publication cannot run before this process dies.
      clock.afterCommit(() => process.kill(process.pid, 'SIGKILL'));
      await step.write({ op: 'create', docs: [{ identifier: 'synthetic-crash', device: 'replay-fixture',
        type: 'sgv', sgv: 123, date: 1793923200000, utcOffset: 0 }], canUpdate: true });
    }));
    throw new Error('Expected producer process death');
  } finally { await raw.end(); }
}
main().catch(() => { process.stderr.write('Synthetic replay producer failed before expected death\n'); process.exitCode = 1; });
