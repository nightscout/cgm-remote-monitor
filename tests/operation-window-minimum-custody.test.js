'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

describe('minimum native fixture custody before optional evidence writes', function () {
  it('retains the write failure and removes its exact created container', async function () {
    const events = [], id = 'a'.repeat(64), name = 'ns-window-minimum-' + '01'.repeat(6);
    const failure = new Error('SYNTHETIC_RECEIPT_DIRECTORY_MISSING');
    let present = false, mode = 'single';
    const childProcess = {
      execFileSync (command, args) {
        assert.equal(command, 'docker'); events.push(args.slice());
        if (args[0] === 'run') { present = true; return id + '\n'; }
        if (args[0] === 'inspect') {
          assert.deepEqual(Array.from(args), ['inspect', '--format', '{{.Name}}', id]); return '/' + name;
        }
        assert.deepEqual(Array.from(args), ['rm', '-f', '-v', id]); present = false; return id;
      },
      spawn (command, args, options) {
        assert.equal(command, 'sh'); assert.equal(options.detached, true);
        assert.equal(args.at(-1), id); events.push(['reaper']);
        return { unref () {} };
      },
      spawnSync (command, args) {
        assert.equal(command, 'docker'); assert.deepEqual(Array.from(args), ['inspect', id]);
        return { status: present ? 0 : 1 };
      }
    };
    const dependencies = {
      'node:assert/strict': assert,
      'node:crypto': { randomBytes: n => Buffer.alloc(n, 1) },
      'node:fs': { writeFileSync (filename) {
        events.push(['artifact', filename]);
        if (filename.endsWith('/custody.json')) throw failure;
        assert.equal(filename, '/synthetic-receipts/cleanup.json');
      } },
      'node:child_process': childProcess,
      pg: { Pool: class {} },
      '../../lib/migrations/postgres': {},
      './multitenant-plan': { A: 'A', B: 'B', layout: () => ({ namespaces: {} }), quote: x => x },
      '../../lib/tenant-lifecycle/operation-window': {},
      '../../lib/storage/postgres-connection': {},
      '../../lib/storage/tenant-scope': { getTenancyMode: () => mode, setTenancyMode: x => { mode = x; } },
      './operation-window-sql-counter': { create: () => ({ phase: (name, fn) => fn() }) }
    };
    const exported = { exports: {} };
    const filename = path.join(__dirname, 'fixtures/operation-window-minimum-native.js');
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module: exported,
      require (name) { assert(Object.hasOwn(dependencies, name), name); return dependencies[name]; },
      process: { pid: 4242, env: { NS_OPERATION_WINDOW_RECEIPT_DIRECTORY: '/synthetic-receipts' } },
      console: { log () {} }
    }, { filename });
    const fixture = exported.exports.create();
    await assert.rejects(fixture.start(), error => error === failure);
    await fixture.close();
    assert.equal(present, false, 'ARTIFACT_FAILURE_MUST_REMOVE_CREATED_CONTAINER');
    const reaperAt = events.findIndex(x => x[0] === 'reaper');
    const receiptAt = events.findIndex(x => x[0] === 'artifact');
    assert(reaperAt > 0 && reaperAt < receiptAt, 'ARM_REAPER_BEFORE_OPTIONAL_CUSTODY_WRITE');
    assert.equal(mode, 'single');
    await fixture.close();
    assert.equal(events.filter(x => x[0] === 'rm').length, 1, 'REMOVE_ONLY_THE_EXACT_OWNED_CONTAINER_ONCE');
  });
});
