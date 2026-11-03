'use strict';

const fs = require('node:fs');
const { MigrationError, loadCatalogue } = require('../../migrations/catalogue');

const USAGE = 'Usage: nightscout migrate <up|status|check> --backend <postgres|mongodb> --namespace NAME ' +
  '--catalogue FILE --connection-env VAR --direct\n' +
  'Operator-only foundation. MongoDB requires a replica set and transactional data steps. No default catalogue, boot migrations or rollback.\n';

function parse (args, env) {
  const [action, ...rest] = args;
  if (!['up', 'status', 'check'].includes(action)) throw new MigrationError('MIG_USAGE', USAGE.trim());
  const values = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (Object.prototype.hasOwnProperty.call(values, flag) ||
        !['--backend', '--namespace', '--catalogue', '--connection-env', '--direct'].includes(flag)) {
      throw new MigrationError('MIG_USAGE', USAGE.trim());
    }
    if (flag === '--direct') values[flag] = true;
    else {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new MigrationError('MIG_USAGE', USAGE.trim());
      values[flag] = value;
    }
  }
  if (!['postgres', 'mongodb'].includes(values['--backend']) || !values['--namespace'] || !values['--catalogue'] ||
      !values['--direct'] || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(values['--connection-env'] || '')) {
    throw new MigrationError('MIG_USAGE', USAGE.trim());
  }
  const connectionString = env[values['--connection-env']];
  if (!connectionString) throw new MigrationError('MIG_CONNECTION', 'the explicitly named operator connection environment variable is empty');
  return { action, backend: values['--backend'], namespace: values['--namespace'],
    file: values['--catalogue'], connectionString, direct: true };
}

async function run (args, io) {
  try {
    const opts = parse(args, io.env);
    // Load only after explicit operator arguments pass; never load the server.
    const catalogue = opts.backend === 'postgres'
      ? { version: 1, migrations: loadCatalogue(opts.file) } : JSON.parse(fs.readFileSync(opts.file, 'utf8'));
    const adapter = opts.backend === 'postgres' ? require('../../migrations/postgres') : require('../../migrations/mongodb');
    const state = await adapter.run(opts.action, { ...opts, catalogue });
    io.stdout.write(JSON.stringify(state) + '\n');
    return state.current ? 0 : 1;
  } catch (error) {
    // SQL and filesystem errors can contain credentials, SQL data or paths.
    // Only our bounded operator errors have messages safe for CLI output.
    const safe = error instanceof MigrationError
      ? error.code + ': ' + error.message : 'MIG_FAILED: migration operation failed; inspect the database with operator tooling';
    io.stderr.write('nightscout migrate: ' + safe + '\n');
    return error.code === 'MIG_USAGE' || error.code === 'MIG_UNSUPPORTED' ? 64 : 1;
  }
}

module.exports = { run, parse };
