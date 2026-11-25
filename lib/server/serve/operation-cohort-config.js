'use strict';

const { PreviewConfigError } = require('./preview-config');
const settings = require('./deployment-settings');
// The operation lease of a tenant-serving role (decision config-few-dozen-env):
// present when the process has the lifetime identity NS_LIFETIME_PG. The
// control namespace and the registry come from NS_PG_PREFIX; the native
// lifecycle selection names the evaluator checkpoint namespace and consumer.
function load (source) {
  const env = settings.withSecrets(source);
  const v = settings.operation(env);
  if (!v) return null;
  const sizing = require('./pool-config').pool('operation', source);
  try {
    const native = require('../../tenant-lifecycle/native-selection');
    const nativeSelection = native.bind(v.nativeSelection, v.namespace);
    const url = new URL(env[v.connectionEnv]);
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
    return Object.freeze({nativeSelection, namespace:v.namespace,
      locks:null, lockRule:'tenant-id-sha256-v1', tenantIds:Object.freeze(['registry:'+v.registry.namespace]), poolOptions});
  } catch (error) {
    if (error instanceof PreviewConfigError) throw error;
    throw new PreviewConfigError('invalid explicit tenant operation configuration');
  }
}
module.exports = {load};
