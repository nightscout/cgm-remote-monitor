#!/usr/bin/env node

'use strict';

// Inner-loop test selection.
//
//   node scripts/test-select.js affected [--last N | --since REF | --files a,b] [--why] [--depth N] [--max N] [--run]
//   node scripts/test-select.js sample [N] [--seed S] [--tier unit,integration,...] [--run]
//   node scripts/test-select.js run [files... | -]
//
// npm run test:affected (with --depth 4) and npm run test:smoke are the
// first two with --run; arguments after -- pass through and a later --depth
// wins, e.g. npm run test:affected -- --depth 10.
//
// `affected` and `sample` print test files one per line on stdout (notes go
// to stderr), so they compose with `run` or any other runner:
//
//   node scripts/test-select.js affected | node scripts/test-select.js run -
//
// `affected` walks a reverse dependency graph built from the string literals
// in every tracked or untracked .js/.mjs file: require()/import paths, relative
// path strings, path.join(__dirname, ...) arguments, template literals (as
// every file under their fixed directory) and `// covers:` lines. It is
// static, so a module loaded by a fully computed name is missed; run the full
// suite before pushing.
//
// Tests that boot the server reach most of lib/ through bootevent, so a
// change to a shared module implicates most of the suite. --depth N keeps
// tests at most N require hops from a changed file. No lib/ file is more than
// 8 hops from a test. In a 100-mutant sample of lib/ on dev eb72a1d3, every
// caught mutant was caught by a test within 4 hops, hence test:affected's
// default.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const tiers = require('./test-tiers');
const tierOf = tiers.tierOf;

const BUNDLE_ENTRIES = ['bundle/bundle.source.js', 'bundle/bundle.clocks.source.js',
  'bundle/bundle.reports.source.js', 'bundle/bundle.admin.source.js',
  'bundle/bundle.profile.source.js', 'bundle/bundle.food.source.js'];
const BUNDLE_OUTPUT = 'node_modules/.cache/_ns_cache/public/js/bundle.app.js';

function git (args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + result.stderr.trim());
  return result.stdout.split('\n').filter(Boolean);
}

function repoFiles () {
  return git(['ls-files', '--cached', '--others', '--exclude-standard'])
    .filter(f => fs.existsSync(path.join(ROOT, f)));
}

function changedFiles (opts) {
  // Uncommitted work is always included: tracked edits (staged or not) and
  // untracked files.
  let files = git(['diff', '--name-only', 'HEAD']).concat(git(['ls-files', '--others', '--exclude-standard']));
  let base;
  if (opts.files) {
    base = 'the --files list';
    files = opts.files;
  } else if (opts.since) {
    // Everything this branch adds on top of REF, as a pull request would show it.
    const mergeBase = git(['merge-base', opts.since, 'HEAD'])[0];
    base = 'merge-base with ' + opts.since + ' (' + mergeBase.slice(0, 8) + ')';
    files = files.concat(git(['diff', '--name-only', mergeBase, 'HEAD']));
  } else {
    // The last N authored commits; merge commits are skipped because their
    // first-parent diff is a whole pull request.
    base = 'the last ' + opts.last + ' non-merge commits';
    files = files.concat(git(['log', '-n', String(opts.last), '--no-merges', '--name-only', '--format=']));
  }
  return { base, files: Array.from(new Set(files)).sort() };
}

function resolveTarget (fromDir, spec, known) {
  const abs = path.resolve(fromDir, spec);
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  if (rel.startsWith('..')) return null;
  const candidates = [rel, rel + '.js', rel + '.mjs', rel + '.json', rel.replace(/\/$/, '') + '/index.js'];
  return candidates.find(c => known.has(c)) || null;
}

function stringLiterals (text) {
  const out = [];
  const re = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
  let m;
  while ((m = re.exec(text))) out.push(m[2]);
  return out;
}

function referencesOf (file, known) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const dir = path.dirname(path.join(ROOT, file));
  const refs = new Set();

  stringLiterals(text).forEach(s => {
    if (!/^\.{1,2}\//.test(s)) return;
    // A template literal such as `../lib/plugins/${name}` may name any file
    // under its fixed directory, so it stands for all of them.
    const hole = s.indexOf('${');
    if (hole >= 0) {
      const prefix = s.slice(0, hole);
      if (!prefix.endsWith('/')) return;
      const base = path.relative(ROOT, path.resolve(dir, prefix)).split(path.sep).join('/') + '/';
      if (base.startsWith('..')) return;
      known.forEach(f => { if (f.startsWith(base) && /\.m?js$/.test(f)) refs.add(f); });
      return;
    }
    const target = resolveTarget(dir, s, known);
    if (target) refs.add(target);
  });

  const joinRe = /path\.(?:join|resolve)\(\s*__dirname\s*,([^)]*)\)/g;
  let m;
  while ((m = joinRe.exec(text))) {
    const parts = stringLiterals(m[1]);
    if (!parts.length) continue;
    const target = resolveTarget(dir, path.join.apply(path, parts), known);
    if (target) refs.add(target);
  }

  // `// covers: lib/a.js, lib/b.js` names what a test exercises when no
  // require or path string shows it, e.g. code run in a child process.
  const coversRe = /\/\/\s*covers:\s*(.+)$/gm;
  while ((m = coversRe.exec(text))) {
    m[1].split(',').map(p => p.trim()).forEach(p => { if (known.has(p)) refs.add(p); });
  }

  if (/bundle\.(?:app|clock|reports|admin|profile|food)\.js|_ns_cache\/public/.test(text)) {
    BUNDLE_ENTRIES.forEach(entry => { if (known.has(entry)) refs.add(entry); });
  }

  refs.delete(file);
  return refs;
}

function reverseGraph (files) {
  const known = new Set(files);
  const dependents = new Map();
  files.filter(f => /\.m?js$/.test(f)).forEach(file => {
    referencesOf(file, known).forEach(target => {
      if (!dependents.has(target)) dependents.set(target, new Set());
      dependents.get(target).add(file);
    });
  });
  return dependents;
}

// Breadth-first from the changed files, so each test is reached by its
// shortest chain; `via` keeps that chain for --why.
function implicated (changed, dependents) {
  const via = new Map();
  const queue = [];
  changed.forEach(f => { via.set(f, null); queue.push(f); });
  while (queue.length) {
    const file = queue.shift();
    (dependents.get(file) || []).forEach(next => {
      if (via.has(next)) return;
      via.set(next, file);
      queue.push(next);
    });
  }
  return via;
}

function chain (via, file) {
  const out = [file];
  while (via.get(out[out.length - 1])) out.push(via.get(out[out.length - 1]));
  return out;
}

function parseArgs (argv) {
  const opts = { _: [], last: 10, depth: Infinity, max: Infinity, tiers: tiers.MAP.smoke };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--last') opts.last = parseInt(argv[++i], 10);
    else if (a === '--since') opts.since = argv[++i];
    else if (a === '--files') opts.files = argv[++i].split(',');
    else if (a === '--depth') opts.depth = parseInt(argv[++i], 10);
    else if (a === '--max') opts.max = parseInt(argv[++i], 10);
    else if (a === '--seed') opts.seed = parseInt(argv[++i], 10);
    else if (a === '--tier') opts.tiers = (argv[++i] || '').split(',');
    else if (a === '--why') opts.why = true;
    else if (a === '--run') opts.run = true;
    else opts._.push(a);
  }
  return opts;
}

function affected (opts) {
  const files = repoFiles();
  const changes = changedFiles(opts);
  const via = implicated(changes.files, reverseGraph(files));
  const allTests = files.filter(tierOf);

  const selected = new Map();
  allTests.forEach(t => { if (via.has(t)) selected.set(t, chain(via, t)); });
  tiers.TIER_NAMES.forEach(name => {
    const infra = tiers.infraFiles(name).filter(f => changes.files.includes(f));
    if (!infra.length) return;
    allTests.filter(t => tierOf(t) === name && !selected.has(t)).forEach(t => selected.set(t, [t, '(tier infrastructure) ' + infra[0]]));
  });

  const hops = t => selected.get(t).length - 1;
  const byHops = {};
  Array.from(selected.keys()).forEach(t => { byHops[hops(t)] = (byHops[hops(t)] || 0) + 1; });

  const ranked = Array.from(selected.keys())
    .filter(t => hops(t) <= opts.depth)
    .sort((a, b) => hops(a) - hops(b) || a.localeCompare(b))
    .slice(0, opts.max);

  console.error('# changed in ' + changes.base + ' and the work tree: ' + changes.files.length + ' files');
  console.error('# implicated tests: ' + selected.size + ' of ' + allTests.length + '; by hops: ' +
    Object.keys(byHops).map(h => h + ':' + byHops[h]).join(' ') +
    (ranked.length < selected.size ? '; printing ' + ranked.length + ' (--depth/--max)' : ''));
  if (changes.files.some(f => /^package(-lock)?\.json$/.test(f))) {
    console.error('# package.json or the lockfile changed: the require graph cannot see that; run the full suite');
  }
  warnStaleBundle(changes.files, via);

  ranked.forEach(t => {
    if (!opts.run) console.log(t);
    if (opts.why) console.error('#   ' + t + ' <- ' + selected.get(t).slice(1).join(' <- '));
  });
  return ranked;
}

function warnStaleBundle (changed, via) {
  if (!BUNDLE_ENTRIES.some(e => via.has(e))) return;
  const bundle = path.join(ROOT, BUNDLE_OUTPUT);
  const built = fs.existsSync(bundle) ? fs.statSync(bundle).mtimeMs : 0;
  const newer = changed.filter(f => {
    const p = path.join(ROOT, f);
    return fs.existsSync(p) && fs.statSync(p).mtimeMs > built;
  });
  const reaches = BUNDLE_ENTRIES.filter(e => via.has(e)).join(', ');
  if (newer.length) {
    console.error('# changes reach ' + reaches + ' and are newer than ' + BUNDLE_OUTPUT + ': run `npm run bundle-dev` first');
  }
}

function sample (opts) {
  const n = parseInt(opts._[0], 10) || 10;
  const seed = Number.isInteger(opts.seed) ? opts.seed : Math.floor(Math.random() * 1e9);
  const bracket = new Set();
  tiers.TIER_NAMES.forEach(name => {
    [].concat(tiers.MAP.tiers[name].first || [], tiers.MAP.tiers[name].last || []).forEach(f => bracket.add(f));
  });
  const pool = tiers.shuffle(repoFiles().filter(f => opts.tiers.includes(tierOf(f)) && !bracket.has(f)).sort(), seed);
  console.error('# sample of ' + Math.min(n, pool.length) + ' from ' + pool.length + ' test files in ' +
    opts.tiers.join(',') + '; replay with --seed ' + seed);
  const picked = pool.slice(0, n).sort();
  if (!opts.run) picked.forEach(f => console.log(f));
  return picked;
}

function run (files) {
  if (files.length === 1 && files[0] === '-') {
    files = fs.readFileSync(0, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  }
  const rels = files.map(f => path.relative(ROOT, path.resolve(f)).split(path.sep).join('/'));
  if (!rels.length) {
    console.error('# no tests selected');
    return 0;
  }
  return tiers.run(tiers.TIER_NAMES, rels);
}

function main () {
  const opts = parseArgs(process.argv.slice(2));
  const command = opts._.shift();
  if (command === 'sample' && !tiers.validateTiers(opts.tiers)) process.exit(2);
  const commands = { affected, sample };
  if (commands[command]) {
    const files = commands[command](opts);
    if (opts.run) process.exit(run(files));
    return;
  }
  if (command === 'run') {
    if (!opts._.length) {
      console.error('# specify test files or - to read the selection from stdin');
      process.exit(2);
    }
    return process.exit(run(opts._));
  }
  console.error('usage: test-select.js affected [--last N | --since REF | --files a,b] [--why] [--depth N] [--max N] [--run]\n' +
    '       test-select.js sample [N] [--seed S] [--tier ' + tiers.TIER_NAMES.join(',') + '] [--run]\n' +
    '       test-select.js run [files... | -]');
  process.exit(2);
}

module.exports = { repoFiles, referencesOf, reverseGraph };

if (require.main === module) main();
