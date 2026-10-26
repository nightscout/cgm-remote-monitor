'use strict';

// Build owned copies of the actual entries. Application files and normal build
// output remain untouched; real dev/hot middleware delivers the updates.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const webpack = require('webpack');
const root = path.resolve(__dirname, '../..');
const config = require('../../webpack/webpack.config');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightscout-page-hmr-'));
fs.mkdirSync(path.join(directory, 'bundle'));
for (const name of ['lib', 'static']) fs.symlinkSync(path.join(root, name), path.join(directory, name), 'dir');
const names = {app: 'bundle.source.js', reports: 'bundle.reports.source.js', admin: 'bundle.admin.source.js', profile: 'bundle.profile.source.js', food: 'bundle.food.source.js', clock: 'bundle.clocks.source.js'};
const sources = new Map(Object.entries(names).map(([entry, file]) => [entry, fs.readFileSync(path.join(root, 'bundle', file), 'utf8')]));
function write(entry, version) {
  fs.writeFileSync(path.join(directory, 'bundle', names[entry]), sources.get(entry) + '\nwindow.pageHotVersions = window.pageHotVersions || {};\nwindow.pageHotVersions[' + JSON.stringify(entry) + '] = ' + version + ';\n');
}
for (const entry of Object.keys(names)) write(entry, 0);
function imports(values) {return values.map(value => value.startsWith('./bundle/') ? path.join(directory, value) : value);}
const entry = Object.fromEntries(Object.entries(config.entry).map(([name, value]) => [name, Array.isArray(value) ? imports(value) : {...value, import: imports(value.import)}]));
const compiler = webpack({...config, entry,
  output: {...config.output, path: path.join(directory, 'output')},
  resolve: {...config.resolve, modules: [path.join(root, 'node_modules'), 'node_modules']},
  resolveLoader: {modules: [path.join(root, 'node_modules')]}
});
const app = express();
const documents = new Map(Object.keys(names).map(name => ['/' + name,
  '<!doctype html><meta charset="utf-8"><title>Page HMR</title><input id="draft" value="retained"><script src="/devbundle/js/bundle.' + (name === 'clock' ? 'clock' : 'app') + '.js"></script>' +
  (name === 'app' || name === 'clock' ? '' : '<script src="/devbundle/js/bundle.' + name + '.js"></script>')]));
app.use((request, response, next) => {
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
  next();
});
for (const [url, html] of documents) app.get(url, (request, response) => response.type('html').send(html));
const development = require('webpack-dev-middleware')(compiler, {publicPath: config.output.publicPath, stats: 'errors-only', hot: {heartbeat: 1000}});
app.use(development);
const server = http.createServer(app);
let origin, latest, closing = false;
function notify() {if (origin && latest && process.connected) process.send({...latest, origin});}
compiler.hooks.done.tap('page-hmr-fixture', stats => {
  latest = stats.hasErrors() ? {error: stats.toString({all: false, errors: true})} : {hash: stats.hash};
  notify();
});
server.listen(0, '127.0.0.1', () => {origin = 'http://127.0.0.1:' + server.address().port; notify();});
async function close() {
  if (closing) return;
  closing = true;
  await new Promise(resolve => development.close(resolve));
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => compiler.close(resolve));
  fs.rmSync(directory, {recursive: true, force: true});
  process.exit(0);
}
process.on('disconnect', close);
process.on('SIGTERM', close);
process.on('message', message => {
  if (message.close) return close();
  if (message.broken && sources.has(message.entry)) {
    fs.writeFileSync(path.join(directory, 'bundle', names[message.entry]), sources.get(message.entry) + '\nconst ownedBrokenFixture = ;\n');
    return;
  }
  if (!sources.has(message.entry) || !Number.isInteger(message.version) || message.version < 1 || message.version > 4) throw new Error('Invalid HMR fixture update');
  write(message.entry, message.version);
});
