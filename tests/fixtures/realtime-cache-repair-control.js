'use strict';
// Test-process-only source ablations. Never edits a worktree or shipping file.
const fs = require('node:fs'), vm = require('node:vm'), Module = require('node:module'), crypto = require('node:crypto');
const mode = process.env.M7_CACHE_CONTROL;
const mutations = {
  'metadata-default': ['../../lib/server/realtime/contract', "const atomic = options?.publication === 'atomic';", "const atomic = options?.publication !== 'read-through';"],
  'ignore-inode': ['../../lib/server/realtime/contract', 'stat.dev, stat.ino, stat.size', 'stat.dev, stat.size'],
  freeze: ['../../lib/server/realtime/contract', "if (state.closed) fail('REALTIME_CONFIG_REFUSED');", "if (state.closed) fail('REALTIME_CONFIG_REFUSED'); if (last !== null) return value;"],
  'outer-cache': ['../../lib/server/realtime/config', 'const read = reread;', `let cached;
    const read = () => { const stat = require('node:fs').statSync(source.MULTITENANT_REALTIME_CONFIG);
      const key = [stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
      if (cached?.key === key) return cached.value;
      const value = reread(); cached = { key,value }; return value; };`],
  'prior-cli-ownership': ['../../lib/cli/commands/multitenant', null, null],
  'prior-serve-precheck': ['../../lib/server/serve', null, null],
  'prior-evaluator-order': ['../../lib/server/serve/evaluator-config', null, null],
  'retain-secondary-placement': ['../../lib/server/serve/evaluator-config', 'parsed.consumers?.realtime?.placement?.close();', '/* control: retain secondary placement */'],
  'late-pool-decode': ['../../lib/server/serve/operation-cohort-config', 'const poolOptions = Object.freeze(', 'const poolOptions = () => Object.freeze('],
  'omit-reader-close': ['../../lib/server/realtime/contract', 'read.close = () => { state.closed = true; abandonedReaders.unregister(state); release(state); };', 'read.close = () => {};']
};
if (!Object.hasOwn(mutations, mode)) throw new Error('M7_CACHE_CONTROL_REQUIRED');
const [relative, before, after] = mutations[mode], filename = require.resolve(relative), currentSource = fs.readFileSync(filename, 'utf8');
const historical = mode.startsWith('prior-');
let source = currentSource;
if (historical) {
  const root = require('node:path').resolve(__dirname, '../..'), path = require('node:path').relative(root, filename);
  const result = require('node:child_process').spawnSync('git', ['show', 'ac8027f912fae9a4e41ed4ac0bbaea2fc7d623f4:' + path], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('M7_CACHE_CONTROL_SOURCE_MISMATCH');
  source = result.stdout;
} else if (!source.includes(before) || source.split(before).length !== 2) throw new Error('M7_CACHE_CONTROL_SOURCE_MISMATCH');
const original = Module.createRequire(filename), output = { exports: {} };
// Load first so the actual module cache entry exists; then replace exports only
// inside this disposable test process with the source-derived ablation.
require(filename);
let changed = historical ? source : source.replace(before, after);
if (mode === 'late-pool-decode') {
  if (changed.split('poolOptions});').length !== 2) throw new Error('M7_CACHE_CONTROL_SOURCE_MISMATCH');
  changed = changed.replace('poolOptions});', 'poolOptions:poolOptions()});');
}
vm.runInThisContext('(function(require,module,exports){' + changed + '\n})', { filename })(original, output, output.exports);
require.cache[filename].exports = output.exports;
// Isolated source wrappers must consume the same ablation as cached exports.
const read = fs.readFileSync;
fs.readFileSync = function (name, options) {
  if (name === filename) return options === 'utf8' || options?.encoding === 'utf8' ? changed : Buffer.from(changed);
  return read.apply(this, arguments);
};
console.log(JSON.stringify({ control: mode, sourceSha256: crypto.createHash('sha256').update(source).digest('hex'), mutationApplied: true, historicalSource: historical ? 'ac8027f912fae9a4e41ed4ac0bbaea2fc7d623f4' : null }));
