'use strict';
const assert=require('node:assert/strict');
const config=require('../lib/pgstream/config');
describe('optional producer startup transport timing contract',function(){
 const selected={timeoutMs:30000,retryIntervalMs:50};
 it('keeps explicit positive representable settings configurable and immutable',function(){
  const value=config.validateStartupTransport(selected);assert.deepEqual(value,selected);assert(Object.isFrozen(value));
  assert.deepEqual(config.validateStartupTransport({timeoutMs:7200000,retryIntervalMs:250}),{timeoutMs:7200000,retryIntervalMs:250});
 });
 it('refuses missing, fractional, overflow, unknown and inconsistent timing rather than clamping it',function(){
  for(const value of [null,{},[],{...selected,timeoutMs:0},{...selected,timeoutMs:1.5},{...selected,timeoutMs:9223372036855},{...selected,retryIntervalMs:30001},{...selected,retryIntervalMs:-1},{...selected,retryIntervalMs:'50'},{...selected,clientTimeoutMs:300000}])assert.throws(()=>config.validateStartupTransport(value),/startup transport milliseconds/);
 });
});
