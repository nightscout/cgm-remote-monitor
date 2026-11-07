'use strict';

// Frozen recovery inputs only: actual consumer/runtime wiring joins final B.
const common = require('../../lib/tenant-operations/common');
const FILE = 'migrations/candidates/postgres-profile-socket-order-v1.json';
function profileInputs ({ writerRole, readerRole, realtimeRole } = {}) {
  const roles = [writerRole, readerRole, realtimeRole];
  if (roles.some(role => typeof role !== 'string' || !common.ROLE.test(role)) || new Set(roles).size !== roles.length) throw common.refuse('PROFILE_INPUT_ROLES_INVALID');
  return {
    sourceCommit: '0bf5cf6daef4bd1adc04f0e689ac179ed63283d8',
    sourceSha256: '3838b60a7fd4cedbd3297dba6022ddff1ba998895bcf113dc85a4339e295bb08',
    candidateDigest: '605d47f194b161279c76eb77261e821c7bb5ed1a251497e84ab6e5dadcd44778',
    selection: { profile: FILE },
    sequence: 'profile_insertion_ordinal_seq',
    acl: { grants: [
      { role: writerRole, kind: 'profile', table: 'profile', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], sequencePrivileges: ['USAGE'] },
      ...[readerRole, realtimeRole].map(role => ({ role, kind: 'profile', table: 'profile', privileges: ['SELECT'] })),
      ...roles.map(role => ({ role, kind: 'profile', table: 'schema_migrations', privileges: ['SELECT'] }))
    ] }
  };
}
module.exports = { profileInputs };
