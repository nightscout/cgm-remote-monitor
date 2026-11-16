'use strict';

// Frozen recovery inputs only: actual consumer/runtime wiring joins final B.
const common = require('../../lib/tenant-operations/common');
const FILE = 'migrations/candidates/postgres-profile-socket-order-v1.json';
function profileInputs ({ writerRole, readerRole, realtimeRole, legacy = false } = {}) {
  const roles = [writerRole, readerRole, realtimeRole];
  if (roles.some(role => typeof role !== 'string' || !common.ROLE.test(role)) || new Set(roles).size !== roles.length) throw common.refuse('PROFILE_INPUT_ROLES_INVALID');
  const historical = {
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
  if (legacy) return historical;
  return {
    sourceCommit: 'f29ff3615e46570b873af1cbe26bbbf4ade80838',
    sourceSha256: '4d95753e76316708ec7cb6f37fbdb88b9e333fe49a5208b5fe7eec68f2fd24f8',
    candidateDigest: '54215036c0d7fa29623b46f40e9ce7f6fbae6266e7bec94d14bff8442791001f',
    selection: { profile: FILE }, counter: 'tenant_insertion_ordinal',
    acl: {
      grants: [
        { role: writerRole, kind: 'profile', table: 'profile', privileges: ['SELECT', 'UPDATE', 'DELETE'] },
        ...[readerRole, realtimeRole].map(role => ({ role, kind: 'profile', table: 'profile', privileges: ['SELECT'] })),
        ...roles.map(role => ({ role, kind: 'profile', table: 'schema_migrations', privileges: ['SELECT'] }))
      ],
      tenantInsertion: [
        { role: writerRole, kind: 'profile', mode: 'serving' },
        ...[readerRole, realtimeRole].map(role => ({ role, kind: 'profile', mode: 'reader' }))
      ]
    }
  };
}
module.exports = { profileInputs };
