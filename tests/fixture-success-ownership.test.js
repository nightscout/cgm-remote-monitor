'use strict';
// covers: tests/fixtures/frame-acquisition.js, tests/storage-port-contract.integration.test.js

// Execute the actual fixture setup/teardown. Only Docker's external boundary is
// replaced; imports, random names and tenant scope are real. Every scenario
// stops at a failed Docker run before a DB connection or test body can execute.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const root = path.resolve(__dirname, '..');
const external = Module.createRequire(require.resolve('pg'));

function protocol (failAt) {
  const calls = [], successful = new Set(), cache = new Map();
  const hooks = { before: [], after: [] };
  let run = 0, depth = 0;
  const noop = () => {};
  function describe (title, body) {
    depth++;
    try { body.call({ timeout: noop }); } finally { depth--; }
  }
  describe.skip = () => { throw new Error('Actual fixture suite must be enabled by its synthetic environment'); };
  const it = noop;
  it.skip = noop;
  const processFacade = Object.create(process);
  Object.defineProperty(processFacade, 'env', {
    value: Object.freeze({ NS_STORAGE_PORT_CONTRACT_DOCKER_TEST: '1' })
  });
  const childProcess = {
    execFileSync (command, args) {
      assert.equal(command, 'docker', 'No other external command is allowed');
      if (args[0] === 'run') {
        const name = args[args.indexOf('--name') + 1];
        assert.equal(typeof name, 'string');
        const returnedSuccess = ++run !== failAt;
        calls.push({ kind: 'run', name, returnedSuccess });
        if (!returnedSuccess) {
          throw Object.assign(new Error('SYNTHETIC_DOCKER_NAME_COLLISION'), { status: 125 });
        }
        successful.add(name);
        return 'synthetic-created-container\n';
      }
      if (args[0] === 'rm') {
        calls.push({ kind: 'rm', argv: [...args], name: args.at(-1) });
        return '';
      }
      throw new Error('Unexpected Docker call before the injected run failure: ' + args[0]);
    }
  };

  function load (file) {
    file = fs.realpathSync(file);
    assert(file.startsWith(root + path.sep), 'Fixture source must remain inside this app tree');
    if (cache.has(file)) return cache.get(file).exports;
    const m = new Module(file);
    m.filename = file;
    m.paths = Module._nodeModulePaths(path.dirname(file));
    cache.set(file, m);
    const source = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.json')) {
      m.exports = JSON.parse(source);
      return m.exports;
    }
    assert(file.endsWith('.js') || file.endsWith('.cjs'), 'Unexpected source module type');
    function localRequire (name) {
      if (['child_process', 'node:child_process'].includes(name)) return childProcess;
      if (Module.isBuiltin(name)) return require(name);
      if (name.startsWith('.') || path.isAbsolute(name)) return load(Module._resolveFilename(name, m));
      return external(name);
    }
    localRequire.resolve = name => name.startsWith('.') ? Module._resolveFilename(name, m) : external.resolve(name);
    localRequire.cache = Object.fromEntries(cache);
    localRequire.main = require.main;
    // Original function body/directives and CommonJS exports are preserved.
    // The local environment and registration hooks do not mutate process.env
    // or the running Mocha suite. No fixture test bodies are executed here.
    const compiled = vm.compileFunction(source,
      ['exports', 'require', 'module', '__filename', '__dirname', 'process',
        'describe', 'it', 'before', 'after', 'beforeEach', 'afterEach'], { filename: file });
    compiled.call(m.exports, m.exports, localRequire, m, file, path.dirname(file), processFacade,
      describe, it, fn => { if (depth === 1) hooks.before.push(fn); },
      fn => { if (depth === 1) hooks.after.push(fn); }, noop, noop);
    m.loaded = true;
    return m.exports;
  }
  return { calls, successful, hooks, load };
}

describe('fixture successful-creation ownership', function () {
  for (const component of ['frame acquisition', 'storage contract']) {
    for (const failAt of [1, 2]) {
      it(component + ' removes only successfully created containers when run ' + failAt + ' fails', async function () {
        const p = protocol(failAt);
        const scope = p.load(path.join(root, 'lib/storage/tenant-scope.js'));
        const initialMode = scope.getTenancyMode();
        let open, close;
        if (component === 'frame acquisition') {
          const fixture = p.load(path.join(root, 'tests/fixtures/frame-acquisition.js'))();
          open = fixture.open;
          close = fixture.close;
        } else {
          p.load(path.join(root, 'tests/storage-port-contract.integration.test.js'));
          assert.equal(p.hooks.before.length, 1, 'Actual root setup must be consumed');
          assert.equal(p.hooks.after.length, 1, 'Actual root teardown must be consumed');
          [open] = p.hooks.before;
          [close] = p.hooks.after;
        }
        try {
          await assert.rejects(open(), { message: 'SYNTHETIC_DOCKER_NAME_COLLISION', status: 125 });
        } finally { await close(); }
        assert.equal(scope.getTenancyMode(), initialMode, 'Actual tenant scope must be restored');
        const starts = p.calls.filter(call => call.kind === 'run');
        const removals = p.calls.filter(call => call.kind === 'rm');
        assert.equal(starts.length, failAt);
        assert.equal(p.successful.size, failAt - 1);
        assert(starts.every(call => /^(frame_test_[a-f0-9]{16}|ns_port_test_[a-f0-9]{32})_(pg|mongo)$/.test(call.name)),
          'The actual random fixture names must be preserved');
        assert.deepEqual(removals.map(call => call.name).sort(), [...p.successful].sort(),
          'OWNERSHIP_SAFE_CLEANUP: never remove an uncreated or foreign name');
        for (const call of removals) assert.deepEqual(call.argv, ['rm', '--force', '--volumes', call.name]);
      });
    }
  }
});
