'use strict';

// Operator configuration of one pool kind, read from the environment:
//   MULTITENANT_POOL_<KIND>_PARTITION   on | off (unset is off)
//   MULTITENANT_POOL_<KIND>_MEMBERS     expected member count (on only)
//   MULTITENANT_POOL_<KIND>_ORDINAL     this worker's ordinal, 0-based (on only)
//   MULTITENANT_POOL_<KIND>_LEASE_MS    heartbeat lease, default 30000 (on only)
//   MULTITENANT_POOL_<KIND>_DATABASE_URL, MULTITENANT_POOL_<KIND>_NAMESPACE
//                                       the membership table's identity (on only)
// Off means one member owns every tenant and no membership row exists. Values
// for the partitioned mode are refused while the flag is off, rather than
// accepted and silently ignored.
const { shape } = require('./slice');

const KIND = /^[a-z][a-z0-9]{0,31}$/;
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const COUNT = /^(0|[1-9][0-9]{0,5})$/;
const DEFAULT_LEASE_MS = 30000;
const PARTITIONED_KEYS = ['MEMBERS', 'ORDINAL', 'LEASE_MS', 'DATABASE_URL', 'NAMESPACE'];

class PoolConfigError extends Error {
  constructor (kind, detail) {
    super('invalid pool configuration for kind ' + kind + ': ' + detail);
    this.code = 'POOL_CONFIG_INVALID';
    this.kind = kind;
  }
}

function checkKind (kind) {
  if (typeof kind !== 'string' || !KIND.test(kind)) throw new TypeError('Pool kind must match ' + KIND);
  return kind;
}

function envName (kind, key) { return 'MULTITENANT_POOL_' + checkKind(kind).toUpperCase() + '_' + key; }

function fromEnvironment (kind, source) {
  checkKind(kind);
  if (!source || typeof source !== 'object') throw new TypeError('Pool configuration source required');
  const read = key => {
    const value = source[envName(kind, key)];
    return value === undefined || value === '' ? undefined : value;
  };
  const flag = read('PARTITION');
  if (flag === undefined || flag === 'off') {
    const stray = PARTITIONED_KEYS.filter(key => read(key) !== undefined);
    if (stray.length) throw new PoolConfigError(kind, 'partition is off but ' + stray.map(key => envName(kind, key)).join(', ') + ' set');
    return Object.freeze({ kind, partitioned: false });
  }
  if (flag !== 'on') throw new PoolConfigError(kind, envName(kind, 'PARTITION') + ' must be on or off');
  const integer = key => {
    const value = read(key);
    if (typeof value !== 'string' || !COUNT.test(value)) throw new PoolConfigError(kind, envName(kind, key) + ' must be a non-negative integer');
    return Number(value);
  };
  const members = integer('MEMBERS'), ordinal = integer('ORDINAL');
  try { shape(members, ordinal); } catch (error) { throw new PoolConfigError(kind, error.message); }
  const leaseMs = read('LEASE_MS') === undefined ? DEFAULT_LEASE_MS : integer('LEASE_MS');
  if (leaseMs < 100 || leaseMs > 600000) throw new PoolConfigError(kind, envName(kind, 'LEASE_MS') + ' must be 100..600000');
  const connectionString = read('DATABASE_URL'), namespace = read('NAMESPACE');
  if (typeof connectionString !== 'string') throw new PoolConfigError(kind, envName(kind, 'DATABASE_URL') + ' required');
  if (typeof namespace !== 'string' || !NAME.test(namespace) || namespace.startsWith('pg_') ||
      ['public', 'information_schema'].includes(namespace)) throw new PoolConfigError(kind, envName(kind, 'NAMESPACE') + ' must be an explicit non-system schema');
  return Object.freeze({ kind, partitioned: true, members, ordinal, leaseMs, connectionString, namespace });
}

module.exports = { fromEnvironment, envName, checkKind, PoolConfigError, DEFAULT_LEASE_MS, KIND };
