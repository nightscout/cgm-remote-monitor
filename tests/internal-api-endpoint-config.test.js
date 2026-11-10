'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const endpoint = require('../lib/server/internal-api/endpoint-config');
const limits = {maxBytes:100000,timeoutMs:1000};
const A = '11111111-1111-4111-8111-111111111111';

describe('independent private internal API endpoint configuration', function () {
  it('resolves explicit UDS, link-local and Kubernetes HTTP references with independent binding', function () {
    assert.deepEqual(endpoint({socketPathEnv:'PRIVATE_SOCKET'}, {PRIVATE_SOCKET:'/run/ns-ipc/api.sock'}, limits), {socketPath:'/run/ns-ipc/api.sock',...limits});
    for (const url of ['http://169.254.20.10:1401', 'http://api-internal.nightscout.svc.cluster.local:1401']) {
      const selected = endpoint({urlEnv:'PRIVATE_API',trust:'network',bindHostEnv:'PRIVATE_BIND'}, {PRIVATE_API:url,PRIVATE_BIND:'0.0.0.0'}, limits);
      assert.deepEqual(selected, {url,trust:'network',bindHost:'0.0.0.0',...limits});
    }
    assert.equal(endpoint.key({url:'http://api-internal:80',trust:'network',...limits}), endpoint.key({url:'http://api-internal/',trust:'network',...limits}));
    assert.notEqual(endpoint.key({url:'http://api-internal:1401',trust:'network',...limits}), endpoint.key({url:'http://realtime-internal:1401',trust:'network',...limits}));
  });
  it('refuses mixed selectors, implicit network trust and public ingress fallback', function () {
    const source = {PRIVATE_API:'http://api-internal:1401',PRIVATE_SOCKET:'/run/ns-ipc/api.sock',PUBLIC_PORT:'1337'};
    for (const description of [{}, {urlEnv:'PRIVATE_API'}, {urlEnv:'PRIVATE_API',trust:'public'}, {urlEnv:'bad ref',trust:'network'},
      {socketPathEnv:'PRIVATE_SOCKET',urlEnv:'PRIVATE_API',trust:'network'}, {urlEnv:'PRIVATE_API',trust:'network',bindHostEnv:'bad ref'},
      {url:'http://api-internal:1401',trust:'network'}]) assert.throws(() => endpoint(description,source,limits), /REFUSED/);
    for (const value of [{}, {socketPathEnv:'PRIVATE_SOCKET',endpoint:{urlEnv:'PRIVATE_API',trust:'network'}}, {endpoint:{urlEnv:'MISSING',trust:'network'}}]) {
      assert.throws(() => endpoint(endpoint.select(value),source,limits), /REFUSED/);
    }
    for (const url of ['http://user:password@api-internal:1401','http://api-internal:1401/public','http://api-internal:1401?public=1','http://api-internal:1401#public']) {
      assert.throws(() => endpoint({urlEnv:'PRIVATE_API',trust:'network'},{...source,PRIVATE_API:url},limits), /REFUSED/);
    }
  });
  it('detects removal of explicit trust from descriptor validation and passes restored source', function () {
    const file = require.resolve('../lib/server/internal-api/endpoint-config');
    const source = fs.readFileSync(file,'utf8'), anchor = "value.trust === 'network'";
    assert(source.includes(anchor));
    const output = {exports:{}};
    vm.compileFunction(source.replace(anchor, 'true'), ['require','module','exports'], {filename:file})(createRequire(file),output,output.exports);
    const refuse = parser => assert.throws(() => parser.describe({urlEnv:'PRIVATE_API',trust:'public'}), /REFUSED/);
    assert.throws(() => refuse(output.exports), assert.AssertionError);
    refuse(endpoint);
  });
  it('keeps the socket authority listener separately addressed and preserves its database authority checks', function () {
    const parse = require('../lib/server/realtime/private-config');
    const value = {endpoint:{urlEnv:'PRIVATE_API',trust:'network',bindHostEnv:'PRIVATE_BIND'},admissionFileEnv:'ADMISSION',maxTenants:2,
      maxMessageBytes:10000,operationTimeoutMs:1000,alarm:{connectionEnv:'ALARM_DB',namespace:'private_alarm'}};
    const source = {PRIVATE_API:'http://api-internal:1401',PRIVATE_BIND:'0.0.0.0',ADMISSION:'/run/ns-config/admission.json',ALARM_DB:'postgres://alarm:synthetic@database:5432/synthetic'};
    const existing = {namespaces:{entries:'clinical_entries'},connections:['postgres://api:synthetic@database:5432/synthetic']};
    assert.deepEqual(parse(value,source,existing).ipc, {url:source.PRIVATE_API,trust:'network',bindHost:'0.0.0.0',maxBytes:10000,timeoutMs:1000});
    assert.throws(() => parse({...value,socketPathEnv:'OTHER'},source,existing), /REFUSED/);
    assert.throws(() => parse(value,{...source,ALARM_DB:existing.connections[0]},existing), /REFUSED/, 'separate alarm database authority still required');
  });
  it('resolves realtime API and alarm endpoints separately and rejects equivalent endpoint collisions', function () {
    const parse = require('../lib/server/realtime/config').parse;
    const value = {version:1,postgres:{connectionEnv:'RT_DB',namespaces:Object.fromEntries(['entries','treatments','devicestatus','profile','food','activity','clock','checkpoint'].map(k=>[k,'endpoint_'+k]))},
      consumer:'realtime-endpoint-test',pageSize:1,maxRows:10,maxBytes:10000,maxTenants:2,recoveryIntervalMs:100,
      tenants:[{id:A,revision:'one',settings:{enable:['bgnow']}}],admissionFileEnv:'ADMISSION',maxMessageBytes:10000,operationTimeoutMs:1000,maxSockets:10,
      apiEndpoint:{urlEnv:'PRIVATE_API',trust:'network'},alarmEndpoint:{urlEnv:'PRIVATE_ALARM',trust:'network',bindHostEnv:'PRIVATE_BIND'}};
    const source = {RT_DB:'postgres://synthetic:synthetic@database/synthetic',ADMISSION:'/run/ns-config/admission.json',
      PRIVATE_API:'http://api-internal:1401',PRIVATE_ALARM:'http://realtime-internal:1402',PRIVATE_BIND:'0.0.0.0'};
    const config = parse(value,source); assert.equal(config.api.url,source.PRIVATE_API); assert.equal(config.alarms.url,source.PRIVATE_ALARM);
    assert.throws(() => parse({...value,apiSocketPathEnv:'OTHER'},source), /REFUSED/);
    assert.throws(() => parse(value,{...source,PRIVATE_ALARM:'http://api-internal:1401/'}), /REFUSED/);
    assert.throws(() => parse({...value,alarmEndpoint:{urlEnv:'PRIVATE_ALARM'}},source), /REFUSED/);
  });
});
