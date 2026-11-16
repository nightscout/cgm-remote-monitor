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
    // Current shared storage-size/backfill and identity tails are part of the
    // exact reviewed successor. Historical recovery input above stays frozen.
    sourceCommit: '83a5cca02728d5751cd056961e7a8f31666a7d3c',
    sourceSha256: 'd9f3ba4be453a304f72efbe1e25673249a18b98d1fd959a530b45d04fea0f59e',
    candidateDigest: 'c1d8238fafb19aa7024edb6051316aa74e16cab3a99ea7b497756f94f5e1a08d',
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
