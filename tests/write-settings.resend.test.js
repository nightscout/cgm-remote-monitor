'use strict';

// ID-RESEND-SWITCH, the settings half (compatibility C, maintainer
// 2026-10-31): WRITE_RESEND=replace|merge|acknowledge|refuse (default
// replace) and WRITE_DELETED_RESEND=stay|revive (default stay), parsed by
// lib/server/write-settings.js with the other WRITE_* settings, read once at
// boot into env.write, and an unknown value refuses to start (a boot error
// from the checkEnv stage). What each mode does to a write is
// tests/write-resend.modes.test.js.

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const writeSettings = require('../lib/server/write-settings');

const MANAGED = ['WRITE_RESEND', 'WRITE_DELETED_RESEND', 'WRITE_IDENTIFIER', 'WRITE_DELETED_EDIT', 'WRITE_VALIDATION'];

// The parse with a reader over `values`, counting how often each name is read.
function parsed (values, reads) {
  return writeSettings.parse(function read (name, fallback) {
    if (reads) reads[name] = (reads[name] || 0) + 1;
    return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : fallback;
  });
}

// env.js under `vars` (process environment, as a deployment sets it).
function withEnv (vars, fn) {
  const saved = { };
  MANAGED.forEach(function (key) { saved[key] = process.env[key]; delete process.env[key]; });
  Object.keys(vars).forEach(function (key) { process.env[key] = vars[key]; });
  try {
    return fn(require('../lib/server/env')());
  } finally {
    MANAGED.forEach(function (key) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
  }
}

// The boot errors bootevent's checkEnv stage records for an env (the stage a
// bad WRITE_* value stops the site at). The boot sequence is captured, not
// run, as tests/legacy-bridge-boot-errors.test.js does.
function checkEnvErrors (env) {
  const filename = path.resolve(__dirname, '../lib/server/bootevent.js');
  const localRequire = createRequire(filename);
  const stages = [ ];
  const sequence = function (list) { stages.push.apply(stages, list); return { boot ( ) { return this; } }; };
  const sandbox = { module: { exports: { } }, console: { log ( ) { } }, process, require (name) {
    if (name === '../utils/boot-sequence') return sequence;
    return localRequire(name);
  } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  sandbox.module.exports(env, { });
  const ctx = { };
  stages.find(function (stage) { return stage.name === 'checkEnv'; })(ctx, function ( ) { });
  return [ ].concat.apply([ ], (ctx.bootErrors || [ ]).map(function (e) { return e.err || [ ]; }))
    .map(function (e) { return e.desc; });
}

describe('WRITE_RESEND and WRITE_DELETED_RESEND (lib/server/write-settings.js)', function ( ) {

  it('the modes, default first', function ( ) {
    assert.deepStrictEqual(writeSettings.RESEND_MODES, ['replace', 'merge', 'acknowledge', 'refuse']);
    assert.deepStrictEqual(writeSettings.DELETED_RESEND_MODES, ['stay', 'revive']);
  });

  it('unset: replace and stay, with no error', function ( ) {
    const result = parsed({ });
    assert.equal(result.write.resend, 'replace');
    assert.equal(result.write.deletedResend, 'stay');
    assert.deepStrictEqual(result.errors, [ ]);
  });

  it('empty is unset', function ( ) {
    const result = parsed({ WRITE_RESEND: '', WRITE_DELETED_RESEND: '' });
    assert.equal(result.write.resend, 'replace');
    assert.equal(result.write.deletedResend, 'stay');
    assert.deepStrictEqual(result.errors, [ ]);
  });

  ['replace', 'merge', 'acknowledge', 'refuse'].forEach(function (mode) {
    it('WRITE_RESEND=' + mode + ' is ' + mode + ', case and surrounding space aside', function ( ) {
      assert.equal(parsed({ WRITE_RESEND: mode }).write.resend, mode);
      assert.equal(parsed({ WRITE_RESEND: ' ' + mode.toUpperCase() + ' ' }).write.resend, mode);
      assert.deepStrictEqual(parsed({ WRITE_RESEND: mode }).errors, [ ]);
    });
  });

  ['stay', 'revive'].forEach(function (mode) {
    it('WRITE_DELETED_RESEND=' + mode + ' is ' + mode + ', case and surrounding space aside', function ( ) {
      assert.equal(parsed({ WRITE_DELETED_RESEND: mode }).write.deletedResend, mode);
      assert.equal(parsed({ WRITE_DELETED_RESEND: '\t' + mode.toUpperCase() }).write.deletedResend, mode);
      assert.deepStrictEqual(parsed({ WRITE_DELETED_RESEND: mode }).errors, [ ]);
    });
  });

  // Values an operator might plausibly type that are not modes: each must stop
  // the site, never fall back silently to the default.
  ['keep', 'ack', 'acknowledged', 'replaced', 'merged', 'off', 'true', 'none', 'reject', 'refused'].forEach(function (value) {
    it('an unknown WRITE_RESEND (' + JSON.stringify(value) + ') is an error', function ( ) {
      const result = parsed({ WRITE_RESEND: value });
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0], 'WRITE_RESEND must be one of replace, merge, acknowledge, refuse; got ' + JSON.stringify(value));
    });
  });

  ['revived', 'restore', 'keep', 'deleted', 'true', 'ignore'].forEach(function (value) {
    it('an unknown WRITE_DELETED_RESEND (' + JSON.stringify(value) + ') is an error', function ( ) {
      const result = parsed({ WRITE_DELETED_RESEND: value });
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0], 'WRITE_DELETED_RESEND must be one of stay, revive; got ' + JSON.stringify(value));
    });
  });

  it('both unknown: two errors, one per setting', function ( ) {
    const result = parsed({ WRITE_RESEND: 'x', WRITE_DELETED_RESEND: 'y' });
    assert.equal(result.errors.length, 2);
    assert.match(result.errors[0], /^WRITE_RESEND /);
    assert.match(result.errors[1], /^WRITE_DELETED_RESEND /);
  });

  it('the other WRITE_* settings parse as before beside them', function ( ) {
    const result = parsed({ WRITE_RESEND: 'merge', WRITE_DELETED_RESEND: 'revive', WRITE_IDENTIFIER: 'strict'
      , WRITE_DELETED_EDIT: 'refuse', WRITE_VALIDATION: 'reject' });
    assert.deepStrictEqual(result.write, { validation: 'reject', identifier: 'strict', deletedEdit: 'refuse'
      , resend: 'merge', deletedResend: 'revive' });
    assert.deepStrictEqual(result.errors, [ ]);
  });

  it('read once: each setting is read one time per parse, and the result is frozen', function ( ) {
    const reads = { };
    const result = parsed({ WRITE_RESEND: 'acknowledge' }, reads);
    assert.equal(reads.WRITE_RESEND, 1);
    assert.equal(reads.WRITE_DELETED_RESEND, 1);
    assert.equal(Object.isFrozen(result.write), true);
    assert.throws(function ( ) { 'use strict'; result.write.resend = 'merge'; }, TypeError);
  });

  it('read once: env.js reads them at boot; a later change to the process environment does not reach env.write', function ( ) {
    withEnv({ WRITE_RESEND: 'refuse', WRITE_DELETED_RESEND: 'revive' }, function (env) {
      assert.equal(env.write.resend, 'refuse');
      assert.equal(env.write.deletedResend, 'revive');
      assert.equal(env.err.length, 0);
      process.env.WRITE_RESEND = 'merge';
      process.env.WRITE_DELETED_RESEND = 'stay';
      assert.equal(env.write.resend, 'refuse');
      assert.equal(writeSettings.resendMode(env), 'refuse');
      assert.equal(writeSettings.deletedResendMode(env), 'revive');
    });
  });

  it('env.js: unset gives replace and stay', function ( ) {
    withEnv({ }, function (env) {
      assert.equal(env.write.resend, 'replace');
      assert.equal(env.write.deletedResend, 'stay');
      assert.equal(env.err.length, 0);
    });
  });

  it('env.js: an unknown value is an env error, and the checkEnv boot stage stops the site with it', function ( ) {
    withEnv({ WRITE_RESEND: 'keep-first', WRITE_DELETED_RESEND: 'undelete' }, function (env) {
      const descs = env.err.map(function (e) { return e.desc; });
      assert.equal(descs.filter(function (d) { return /^WRITE_RESEND must be one of/.test(d); }).length, 1);
      assert.equal(descs.filter(function (d) { return /^WRITE_DELETED_RESEND must be one of/.test(d); }).length, 1);
      const boot = checkEnvErrors(env);
      assert(boot.some(function (d) { return /^WRITE_RESEND must be one of/.test(d); }), boot.join('; '));
      assert(boot.some(function (d) { return /^WRITE_DELETED_RESEND must be one of/.test(d); }), boot.join('; '));
    });
  });

  it('env.js: a known value records no boot error', function ( ) {
    withEnv({ WRITE_RESEND: 'acknowledge', WRITE_DELETED_RESEND: 'stay' }, function (env) {
      assert.deepStrictEqual(checkEnvErrors(env).filter(function (d) { return /WRITE_/.test(d); }), [ ]);
    });
  });

  it('resendMode / deletedResendMode: the defaults for an env without them (a test env, an in-process caller)', function ( ) {
    assert.equal(writeSettings.resendMode({ }), 'replace');
    assert.equal(writeSettings.resendMode(undefined), 'replace');
    assert.equal(writeSettings.resendMode({ write: { resend: 'bogus' } }), 'replace');
    assert.equal(writeSettings.resendMode({ write: { resend: 'merge' } }), 'merge');
    assert.equal(writeSettings.deletedResendMode({ }), 'stay');
    assert.equal(writeSettings.deletedResendMode({ write: { deletedResend: 'revive' } }), 'revive');
  });

  it('resendModeFor: the per-client seam answers the site setting for any client today', function ( ) {
    const env = { write: { resend: 'acknowledge' } };
    assert.equal(writeSettings.resendModeFor(env), 'acknowledge');
    assert.equal(writeSettings.resendModeFor(env, null), 'acknowledge');
    assert.equal(writeSettings.resendModeFor(env, { product: 'synthetic-client', version: '1.0.0' }), 'acknowledge');
    assert.equal(writeSettings.resendModeFor({ }, { product: 'synthetic-client' }), 'replace');
  });
});
