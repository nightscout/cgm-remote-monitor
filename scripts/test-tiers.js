#!/usr/bin/env node

'use strict';

// The test tier map, tests/tiers.json: which tier each test file belongs to
// and how that tier is run. The npm test:* scripts run tiers through this
// file, scripts/test-select.js groups the files it selects by it, and
// `check` keeps the map, the test files and the source they cover in step.
//
//   node scripts/test-tiers.js run <tier[,tier...]> [--ci] [files...]
//   node scripts/test-tiers.js list [tier]
//   node scripts/test-tiers.js check
//
// `run` with no files runs the whole tier. --ci uses tests/ci.test.env;
// otherwise TEST_ENV_FILE, then ./my.test.env, then tests/ci.test.env.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MAP = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/tiers.json'), 'utf8'));

function globToRegExp (glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') {
      re += '[^/]*';
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

const TEST_FILE = globToRegExp(MAP.testFiles);
const TIER_NAMES = Object.keys(MAP.tiers);
const MATCHERS = {};
TIER_NAMES.forEach(name => {
  MATCHERS[name] = MAP.tiers[name].files.map(glob => ({ glob, re: globToRegExp(glob) }));
});

function tiersOf (file) {
  return TIER_NAMES.filter(name => MATCHERS[name].some(m => m.re.test(file)));
}

function tierOf (file) {
  const tiers = tiersOf(file);
  return tiers.length === 1 ? tiers[0] : undefined;
}

function listTestFiles () {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'tests'], { cwd: ROOT, encoding: 'utf8' });
  return result.stdout.split('\n').filter(f => TEST_FILE.test(f) && fs.existsSync(path.join(ROOT, f))).sort();
}

function envFile (ci) {
  if (ci) return './tests/ci.test.env';
  if (process.env.TEST_ENV_FILE) return process.env.TEST_ENV_FILE;
  return fs.existsSync(path.join(ROOT, 'my.test.env')) ? './my.test.env' : './tests/ci.test.env';
}

// Files outside the tests' require graph that still change every test in a
// tier: its root hooks, its `covers` list and, for tiers that read one, the
// env files.
function infraFiles (name) {
  const tier = MAP.tiers[name];
  const files = (tier.require || []).map(f => path.normalize(f)).concat(tier.covers || []);
  if (tier.env) files.push('tests/ci.test.env', 'my.test.env');
  return files;
}

function bin (name) {
  return path.join(ROOT, 'node_modules', '.bin', name);
}

// Runs mocha with a tier's env file: bin/with-env.js where the repository has
// it (it replaces env-cmd), env-cmd otherwise.
function withEnv (file, args) {
  const loader = path.join(ROOT, 'bin', 'with-env.js');
  if (fs.existsSync(loader)) return [process.execPath, [loader, file, path.join(ROOT, 'node_modules', 'mocha', 'bin', 'mocha.js')].concat(args)];
  return [bin('env-cmd'), ['-f', file, bin('mocha')].concat(args)];
}

function command (name, files, ci) {
  const tier = MAP.tiers[name];
  // A tier's first and last files run around any subset of it; they may
  // belong to another tier (the database safety check and clean-up).
  const first = tier.first || [];
  const last = tier.last || [];
  const body = files.filter(f => !first.includes(f) && !last.includes(f));
  const args = ['--timeout', String(tier.timeout)];
  (tier.require || []).forEach(r => args.push('--require', r));
  if (tier.exit) args.push('--exit');
  if (tier.parallel) args.push('--parallel', '--jobs', String(tier.parallel));
  const ordered = first.concat(body, last).map(f => './' + f);
  if (tier.env) return withEnv(envFile(ci), args.concat(ordered));
  return [bin('mocha'), args.concat(ordered)];
}

// Runs each named tier in map order; with files, only those files (plus the
// tier's first and last files). Returns the first non-zero exit status.
function run (names, files, ci) {
  const all = listTestFiles();
  let status = 0;
  TIER_NAMES.filter(name => names.includes(name)).forEach(name => {
    const members = (files ? files : all).filter(f => tierOf(f) === name);
    if (!members.length) return;
    const cmd = command(name, members, ci);
    console.error('# ' + name + ': ' + members.length + ' test files');
    const result = spawnSync(cmd[0], cmd[1], { cwd: ROOT, stdio: 'inherit' });
    if (result.status !== 0 && !status) status = result.status || 1;
  });
  return status;
}

// Every test file in exactly one tier, every glob matching a file, and every
// test reaching some non-test file through the require graph, declaring what
// it covers with a `// covers:` line, or in a tier with a `covers` list, so
// that test-select.js can find it from a change.
function check () {
  const { repoFiles, referencesOf } = require('./test-select');
  const problems = [];
  const tests = listTestFiles();

  tests.forEach(f => {
    const tiers = tiersOf(f);
    if (tiers.length === 0) problems.push(f + ': in no tier; add it to tests/tiers.json');
    if (tiers.length > 1) problems.push(f + ': in more than one tier (' + tiers.join(', ') + ')');
  });
  TIER_NAMES.forEach(name => {
    MATCHERS[name].forEach(m => {
      if (!tests.some(f => m.re.test(f))) problems.push('tests/tiers.json ' + name + ': "' + m.glob + '" matches no test file');
    });
    [].concat(MAP.tiers[name].first || [], MAP.tiers[name].last || []).forEach(f => {
      if (!tests.includes(f)) problems.push('tests/tiers.json ' + name + ': first/last file ' + f + ' is not a test file');
    });
  });

  const files = repoFiles();
  const known = new Set(files);
  const refs = new Map();
  const refsOf = f => {
    if (!refs.has(f)) refs.set(f, f.endsWith('.js') ? referencesOf(f, known) : new Set());
    return refs.get(f);
  };
  tests.forEach(t => {
    const tier = MAP.tiers[tierOf(t)];
    const declared = [];
    const coversRe = /\/\/\s*covers:\s*(.+)$/gm;
    let m;
    while ((m = coversRe.exec(fs.readFileSync(path.join(ROOT, t), 'utf8')))) {
      m[1].split(',').map(p => p.trim()).forEach(p => {
        if (known.has(p)) declared.push(p);
        else problems.push(t + ': covers ' + p + ', which is not a file in the repository');
      });
    }
    if (declared.length || (tier && tier.covers)) return;
    const seen = new Set([t]);
    const queue = [t];
    let reaches = false;
    while (queue.length && !reaches) {
      refsOf(queue.shift()).forEach(next => {
        if (seen.has(next)) return;
        seen.add(next);
        if (!next.startsWith('tests/')) reaches = true;
        else queue.push(next);
      });
    }
    if (!reaches) problems.push(t + ': reaches no source file; add a `// covers: <path>` line naming what it tests');
  });

  problems.forEach(p => console.error(p));
  console.error('# ' + tests.length + ' test files, ' + TIER_NAMES.length + ' tiers: ' + (problems.length ? problems.length + ' problems' : 'ok'));
  return problems.length ? 1 : 0;
}

module.exports = { MAP, TIER_NAMES, tierOf, tiersOf, listTestFiles, infraFiles, run };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv.shift();
  const ci = argv.includes('--ci');
  const rest = argv.filter(a => a !== '--ci');
  if (cmd === 'run' && rest.length) {
    const files = rest.length > 1 ? rest.slice(1).map(f => path.relative(ROOT, path.resolve(f)).split(path.sep).join('/')) : null;
    process.exit(run(rest[0].split(','), files, ci));
  } else if (cmd === 'list') {
    listTestFiles().filter(f => !rest[0] || tierOf(f) === rest[0]).forEach(f => console.log(f));
  } else if (cmd === 'check') {
    process.exit(check());
  } else {
    console.error('usage: test-tiers.js run <tier[,tier...]> [--ci] [files...] | list [tier] | check');
    process.exit(2);
  }
}
