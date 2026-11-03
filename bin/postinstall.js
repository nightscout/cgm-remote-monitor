'use strict';

// npm postinstall: build the production web bundle, then generate the
// runtime key (node_modules/.cache/_ns_cache/randomString).
//
// webpack and its loaders are devDependencies, so an install that omits dev
// dependencies (--omit=dev, --production or NODE_ENV=production) cannot build
// the bundle. In that case keep a bundle that is already built, or stop with
// a message naming the fix: the server serves pages from this bundle and
// would otherwise start without one.

const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const cache = path.join(root, 'node_modules/.cache/_ns_cache');
// Every split page entry is required for a usable prebuilt installation.
const bundles = ['app', 'reports', 'admin', 'profile', 'food', 'clock']
  .map(name => path.join(cache, 'public/js/bundle.' + name + '.js'));

function resolve (request) {
  try {
    return require.resolve(request, {paths: [root]});
  } catch (err) {
    return null;
  }
}

function run (args) {
  const result = spawnSync(process.execPath, args, {cwd: root, stdio: 'inherit'});
  if (result.error) throw result.error;
  return result.status === null ? 1 : result.status;
}

function generateKeys () {
  fs.mkdirSync(cache, {recursive: true});
  const out = fs.openSync(path.join(cache, 'randomString'), 'w');
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'generateRandomString.js')],
      {cwd: root, stdio: ['ignore', out, 'inherit']});
    if (result.error) throw result.error;
    return result.status === null ? 1 : result.status;
  } finally {
    fs.closeSync(out);
  }
}

function main () {
  // webpack's own bin asks to install webpack-cli when it is missing, so
  // check for both before building.
  const webpack = resolve('webpack/package.json');
  const cli = resolve('webpack-cli/bin/cli.js');

  if (webpack && cli) {
    const status = run([cli, '--mode', 'production', '--config', 'webpack/webpack.config.js']);
    if (status !== 0) return status;
    return generateKeys();
  }

  if (bundles.every(file => fs.existsSync(file))) {
    console.warn('Nightscout postinstall: the build tools (webpack) are not installed, so the web page ' +
      'bundle was not rebuilt. Keeping the bundle already in ' + path.relative(root, cache) + '/public, built ' +
      fs.statSync(bundles[0]).mtime.toISOString() + '. If the source has changed since then, rebuild it: ' +
      'npm ci --include=dev');
    return generateKeys();
  }

  console.error([
    '',
    'Nightscout postinstall: cannot build the web page bundle.',
    'The build tools (webpack and Babel) are development dependencies, and this install left them out',
    '(--omit=dev, --production or NODE_ENV=production). Without the bundle, Nightscout pages cannot load.',
    '',
    'Install with the development dependencies, which builds the bundle:',
    '  npm ci --include=dev',
    'Then, to remove the build tools from the installed site:',
    '  npm prune --omit=dev --ignore-scripts',
    ''
  ].join('\n'));
  return 1;
}

process.exitCode = main();
