'use strict';

// Persistent compiler for the asset/HMR contract test. All modified source and
// emitted updates live in an owned temporary directory, outside app assets.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const webpack = require('webpack');
const config = require('../../webpack/webpack.config');
const root = path.resolve(__dirname, '../..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightscout-assets-'));
const source = path.join(directory, 'source');
const output = path.join(directory, 'output');
fs.mkdirSync(path.join(source, 'css'), {recursive: true});
fs.mkdirSync(path.join(source, 'images'));
const css = fs.readFileSync(path.join(root, 'static/css/drawer.css'), 'utf8');
fs.copyFileSync(path.join(root, 'static/images/logo2.png'), path.join(source, 'images/logo2.png'));
fs.writeFileSync(path.join(source, 'css/drawer.css'), css);
fs.writeFileSync(path.join(source, 'entry.js'), [
  "require('./css/drawer.css');",
  'window.assetBoots = (window.assetBoots || 0) + 1;',
  'window.assetHot = module.hot;',
  "module.hot.accept('./css/drawer.css', function () {});"
].join('\n'));
const compiler = webpack({
  ...config,
  recordsPath: path.join(directory, 'records.json'),
  entry: {fixture: path.join(source, 'entry.js')},
  resolve: {...config.resolve, modules: [path.join(root, 'node_modules'), 'node_modules']},
  resolveLoader: {modules: [path.join(root, 'node_modules')]},
  output: {...config.output, path: output}
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await new Promise(resolve => compiler.close(resolve));
  fs.rmSync(directory, {recursive: true, force: true});
  process.exit(0);
}
process.on('disconnect', close);
process.on('SIGTERM', close);
process.on('message', message => {
  if (message.close) return close();
  if (message.color) fs.writeFileSync(path.join(source, 'css/drawer.css'), css + '\n#toolbar { background-color: ' + message.color + '; }\n');
  compiler.run((error, stats) => {
    const failure = error || (stats.hasErrors() && new Error(stats.toString({all: false, errors: true})));
    process.send(failure ? {error: failure.message} : {output, hash: stats.hash, assets: Object.keys(stats.compilation.assets)});
  });
});
process.send({ready: true});
