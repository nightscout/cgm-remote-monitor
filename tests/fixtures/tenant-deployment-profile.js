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
    sourceCommit: 'abfb36dfb27288fb06c94b9bb1a30a9586f3f2bb',
    sourceSha256: '60bb63d53357dcf14013859517d82a76fc12bc0ed027795c237154d4a35d1a28',
    candidateDigest: '1a886ab1df7ccd9203fee9ccb0ac0f96252b69096aedd05c08bb1821525e9edc',
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
