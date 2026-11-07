'use strict';
const c = require('../realtime/contract');
const ipc = require('../realtime/ipc');
const entries=new WeakSet();
const ROLES = Object.freeze(['api','evaluator','realtime','tenant-admin']);
const name = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(value) && value !== 'public' && value !== 'information_schema' && !value.startsWith('pg_');
function validate (rows) {
  if (!Array.isArray(rows) || !rows.length) throw new TypeError('Explicit fixed participant manifest required');
  const ids=new Set(), paths=new Set(), roles=new Set();
  const result=rows.map(row => {
    if (!c.exact(row,['id','roles','namespaces','endpoint']) || typeof row.id !== 'string' || !/^[a-z][a-z0-9_-]{0,62}$/.test(row.id) || ids.has(row.id) ||
      !Array.isArray(row.roles) || !row.roles.length || new Set(row.roles).size !== row.roles.length || row.roles.some(role => !ROLES.includes(role)) ||
      !Array.isArray(row.namespaces) || !row.namespaces.length || new Set(row.namespaces).size !== row.namespaces.length || row.namespaces.some(ns => !name(ns))) throw new TypeError('Invalid fixed participant manifest');
    ipc.options(row.endpoint); if (paths.has(row.endpoint.socketPath)) throw new TypeError('Duplicate participant endpoint');
    ids.add(row.id); paths.add(row.endpoint.socketPath); row.roles.forEach(role => roles.add(role));
    const entry=Object.freeze({id:row.id,roles:Object.freeze([...row.roles].sort()),namespaces:Object.freeze([...row.namespaces].sort()),endpoint:Object.freeze({...row.endpoint})});
    entries.add(entry); return entry;
  });
  if (ROLES.some(role => !roles.has(role))) throw new TypeError('Fixed participant manifest must cover every role');
  return Object.freeze(result);
}
module.exports={validate,ROLES,isParticipant:value => entries.has(value)};
