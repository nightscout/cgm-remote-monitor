'use strict';
// Recording lifetime/backend protocol only, not PostgreSQL or process evidence.
const { EventEmitter } = require('node:events');
const { create } = require('../../lib/tenant-lifecycle/operation-window');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
module.exports = function fixture (options = {}) {
  const log = [], pending = new Map();
  const admission = require('./operation-window-admission-protocol')();
  const client = new EventEmitter();
  client.processID = 123;
  client.release = error => log.push(['release', !!error]);
  client.query = async (text, values) => {
    log.push([text, values]);
    const metadata = admission(text, values); if (metadata) return metadata;
    if (text.includes('FROM pg_roles')) return { rows: [{ rolsuper: !!options.superuser, rolbypassrls: false,
      ...(text.includes('pg_backend_pid') ? { pid: options.sqlPid || 123, role: options.sqlRole || 'synthetic_worker', birth: options.sqlBirth || '1700000000.000001' } : {}) }] };
    if (text.startsWith('SELECT pg_backend_pid()')) return { rows: [{ pid: options.sqlPid || 123, role: options.sqlRole || 'synthetic_worker', birth: options.sqlBirth || '1700000000.000001' }] };
    if (text.includes('pg_try_advisory_lock_shared')) return { rows: [{ held: options.held !== false }] };
    if (text.includes('pg_advisory_unlock_shared')) return { rows: [{ released: options.unlock !== false }] };
    if (text === 'SHOW transaction_read_only') return { rows: [{ transaction_read_only: options.metadataReadOnly || 'on' }] };
    if (text.startsWith('SELECT lock_key')) return { rows: [{ lock_key: options.key || (values[0] === B ? '19' : '17'), phase: options.phase || 'active', generation: '1' }] };
    if (text.startsWith('INSERT INTO')) { pending.set(values[1], false); return { rows: [], rowCount: 1 }; }
    if (text.startsWith('UPDATE')) { pending.set(values[1], true); return { rows: [], rowCount: 1 }; }
    return { rows: [], ...(['COMMIT','ROLLBACK'].includes(text) ? { command: text } : {}) };
  };
  const pool = { connect: async () => client };
  return { client, log, pending, window: create({ namespace: 'synthetic_window', locks: [{ tenant: A, key: '17' }, { tenant: B, key: '19' }], pool }) };
};
