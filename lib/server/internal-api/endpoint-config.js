'use strict';

// Configuration describes an independently bound private service endpoint.
// Resolve addresses only from named environment references, never public ingress.
const transport = require('./transport');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const refused = () => { throw Object.assign(new Error('INTERNAL_API_ENDPOINT_CONFIG_REFUSED'), {code:'INTERNAL_API_ENDPOINT_CONFIG_REFUSED'}); };
const referenceName = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(value);
function describe (value) {
  if (exact(value, ['socketPathEnv']) && referenceName(value.socketPathEnv)) return {...value};
  if (exact(value, ['urlEnv', 'trust'], ['bindHostEnv']) && value.trust === 'network' && referenceName(value.urlEnv) &&
      (!Object.hasOwn(value, 'bindHostEnv') || referenceName(value.bindHostEnv))) return {...value};
  refused();
}
function select (value, socketKey = 'socketPathEnv', endpointKey = 'endpoint') {
  if (!object(value) || Object.hasOwn(value, socketKey) === Object.hasOwn(value, endpointKey)) refused();
  return describe(Object.hasOwn(value, endpointKey) ? value[endpointKey] : {socketPathEnv:value[socketKey]});
}
function parse (value, source, limits) {
  if (!exact(limits, ['maxBytes', 'timeoutMs'])) refused();
  const selected = describe(value);
  const reference = name => {
    if (!source || typeof source[name] !== 'string' || !source[name]) refused();
    return source[name];
  };
  return transport.options(selected.socketPathEnv ? {socketPath:reference(selected.socketPathEnv), ...limits} :
    {url:reference(selected.urlEnv), trust:selected.trust, ...(selected.bindHostEnv ? {bindHost:reference(selected.bindHostEnv)} : {}), ...limits});
}
function key (value) { return value.socketPath ? 'unix:' + value.socketPath : 'http:' + new URL(value.url).origin; }
module.exports = Object.assign(parse, {describe,select,key});
