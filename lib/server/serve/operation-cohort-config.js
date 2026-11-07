'use strict';

const c = require('../realtime/contract');
const { PreviewConfigError } = require('./preview-config');
const { readRaw } = require('./listeners');
function load (source) {
  const file = readRaw(source, 'MULTITENANT_OPERATION_CONFIG');
  if (!file) return null;
  try {
    const v = c.file(file);
    const fields = ['version','namespace','connectionEnv','locks'];
    if (v.version === 2) fields.push('participantId','participants');
    if (!c.exact(v, fields) || ![1,2].includes(v.version) ||
        typeof v.namespace !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(v.namespace) ||
        ['public', 'information_schema'].includes(v.namespace) || v.namespace.startsWith('pg_') ||
        !Array.isArray(v.locks) || !v.locks.length) throw new Error();
    const tenants = new Set(), keys = new Set();
    for (const row of v.locks) {
      if (!c.exact(row, ['tenant', 'key']) || !c.uuid(row.tenant) || row.tenant === '00000000-0000-0000-0000-000000000000' ||
          typeof row.key !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.key) || BigInt(row.key) > 9223372036854775807n ||
          tenants.has(row.tenant) || keys.has(row.key)) throw new Error();
      tenants.add(row.tenant); keys.add(row.key);
    }
    let participants;
    if (v.version === 2) {
      if (!Array.isArray(v.participants)) throw new Error();
      participants = require('./operation-cohort-manifest').validate(v.participants.map(row => {
        if (!c.exact(row,['id','roles','namespaces','socketPathEnv','maxMessageBytes','timeoutMs'])) throw new Error();
        return {id:row.id,roles:row.roles,namespaces:row.namespaces,endpoint:{socketPath:c.reference(row.socketPathEnv,source),maxBytes:row.maxMessageBytes,timeoutMs:row.timeoutMs}};
      }));
      if (!participants.some(row => row.id === v.participantId)) throw new Error();
    }
    const url = new URL(c.reference(v.connectionEnv, source));
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || !url.pathname.slice(1) || url.hash ||
        [...url.searchParams.keys()].some(key => key !== 'sslmode') || url.searchParams.getAll('sslmode').length > 1 ||
        (url.search && !['disable', 'verify-full'].includes(url.searchParams.get('sslmode')))) throw new Error();
    return Object.freeze({...(participants ? {participantId:v.participantId,participants} : {}),namespace:v.namespace, locks:Object.freeze(v.locks.map(row => Object.freeze({...row}))),
      poolOptions:Object.freeze({host:url.hostname.replace(/^\[|\]$/g, ''), port:url.port ? Number(url.port) : 5432,
        user:decodeURIComponent(url.username), password:decodeURIComponent(url.password), database:decodeURIComponent(url.pathname.slice(1)),
        ssl:url.searchParams.get('sslmode') === 'verify-full' ? {rejectUnauthorized:true} : false,
        options:'-c search_path=pg_catalog', client_encoding:'UTF8', max:8,
        connectionTimeoutMillis:5000, statement_timeout:5000, application_name:'nightscout-operation-lifetime'})});
  } catch { throw new PreviewConfigError('invalid explicit tenant operation configuration'); }
}
module.exports = {load};
