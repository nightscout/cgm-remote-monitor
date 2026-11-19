'use strict';

const c = require('../realtime/contract');
const { PreviewConfigError } = require('./preview-config');
const { readRaw } = require('./listeners');
// The lifecycle operation window of one role process. Instance identity is not
// configured here: a process's slice is its ordinal and count
// (lib/pool-membership/slice.js fromEnvironment).
function load (source) {
  const file = readRaw(source, 'MULTITENANT_OPERATION_CONFIG');
  if (!file) return null;
  const sizing = require('./pool-config').pool('operation', source);
  try {
    const v = c.file(file, { label: 'MULTITENANT_OPERATION_CONFIG', source });
    // Registry mode (decision tenant-registry): `registry: { namespace }` in place
    // of `locks`; lock keys follow the tenant-id rule and the cohort's tenant set
    // is the registry, named by its namespace.
    const registryMode = v && typeof v === 'object' && Object.hasOwn(v, 'registry');
    const fields = ['version','namespace','connectionEnv',registryMode ? 'registry' : 'locks'];
    if (!c.exact(v, fields, ['leaseSessions','intakeProfile','nativeSelection']) || v.version !== 1 ||
        v.leaseSessions !== undefined && (!Number.isSafeInteger(v.leaseSessions) || v.leaseSessions < 1 || v.leaseSessions > sizing.max) ||
        typeof v.namespace !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(v.namespace) ||
        ['public', 'information_schema'].includes(v.namespace) || v.namespace.startsWith('pg_') ||
        (registryMode ? (!c.exact(v.registry, ['namespace']) || typeof v.registry.namespace !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(v.registry.namespace))
          : (!Array.isArray(v.locks) || !v.locks.length))) throw new Error();
    const tenants = new Set(), keys = new Set();
    for (const row of v.locks || []) {
      if (!c.exact(row, ['tenant', 'key']) || !c.uuid(row.tenant) || row.tenant === '00000000-0000-0000-0000-000000000000' ||
          typeof row.key !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.key) || BigInt(row.key) > 9223372036854775807n ||
          tenants.has(row.tenant) || keys.has(row.key)) throw new Error();
      tenants.add(row.tenant); keys.add(row.key);
    }
    if(v.nativeSelection!==undefined&&v.intakeProfile!==undefined)throw new Error();
    // The native lifecycle selection keeps its own key; intakeProfile is only
    // a legacy fixed or pool profile (legacy-topology-retirement).
    const native = require('../../tenant-lifecycle/native-selection');
    const nativeSelection = v.nativeSelection === undefined ? undefined : native.bind(native.create(v.nativeSelection), v.namespace);
    const intakeProfile = v.intakeProfile === undefined ? undefined : require('../../tenant-lifecycle/generation-domain').bind(v.intakeProfile,v.namespace,v.locks?.map(row=>row.tenant));
    if (intakeProfile !== undefined && native.isNative(intakeProfile)) throw new Error();
    const url = new URL(c.reference(v.connectionEnv, source));
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || !url.pathname.slice(1) || url.hash ||
        [...url.searchParams.keys()].some(key => key !== 'sslmode') || url.searchParams.getAll('sslmode').length > 1 ||
        (url.search && !['disable', 'verify-full'].includes(url.searchParams.get('sslmode')))) throw new Error();
    // Finish every fallible URL decode before acquiring a retained placement
    // reader: a refused configuration must not depend on finalizer cleanup.
    const poolOptions = Object.freeze({host:url.hostname.replace(/^\[|\]$/g, ''), port:url.port ? Number(url.port) : 5432,
        user:decodeURIComponent(url.username), password:decodeURIComponent(url.password), database:decodeURIComponent(url.pathname.slice(1)),
        ssl:url.searchParams.get('sslmode') === 'verify-full' ? {rejectUnauthorized:true} : false,
        options:'-c search_path=pg_catalog', client_encoding:'UTF8', max:sizing.max,
        connectionTimeoutMillis:sizing.connectionTimeoutMillis, statement_timeout:5000, application_name:'nightscout-operation-lifetime'});
    require('../../realtime-ownership').refuseLegacy(source);
    return Object.freeze({...(intakeProfile ? {intakeProfile} : {}),...(nativeSelection ? {nativeSelection} : {}),namespace:v.namespace,
      ...(v.leaseSessions === undefined ? {} : { leaseSessions: v.leaseSessions }),
      ...(registryMode ? {locks:null, lockRule:'tenant-id-sha256-v1', tenantIds:Object.freeze(['registry:'+v.registry.namespace])}
        : {locks:Object.freeze(v.locks.map(row => Object.freeze({...row}))), tenantIds:Object.freeze(v.locks.map(row => row.tenant))}),
      poolOptions});
  } catch (error) {
    // A bounded-read refusal (MULTITENANT_CONFIG_MAX_BYTES) keeps its named cause.
    if (c.isConfigFileRefusal(error)) throw Object.assign(new PreviewConfigError(error.message), { code: error.code });
    throw new PreviewConfigError('invalid explicit tenant operation configuration');
  }
}
module.exports = {load};
