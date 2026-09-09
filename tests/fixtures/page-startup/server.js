'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const express = require('express');
const ejs = require('ejs');
const {Server} = require('socket.io');
const hash = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

const pages = [
  ['/', 'index.html', 'index', 'app'],
  ['/report/', 'reportindex.html', 'reports', 'reports'],
  ['/admin/', 'adminindex.html', 'admin', 'admin'],
  ['/profile', 'profileindex.html', 'profile', 'profile'],
  ['/food', 'foodindex.html', 'food', 'food']
];

async function createPageFixture(options = {}) {
  const root = options.root || path.resolve(__dirname, '../../..');
  let server, io, origin;
  const pendingRequests = new Map();
  const state = {requests: [], authorizations: 0, glucose: 123, foodWrites: [], challenges: 0, foodFailures: 0, loadingResponses: 0, buildVersion: 'page-startup', workerVersion: 'page-startup', blockBundles: false, bundleRequests: [], traffic: []};
  const app = express();
  if (options.compress) app.use(require('compression')());
  const apiData = request => options.apiData && options.apiData[request.path] || [];
  const settings = structuredClone(require('../default-server-settings'));
  settings.settings.enable += ' food';
  app.use((request, response, next) => {
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'");
    next();
  });
  app.use((request, response, next) => {
    pendingRequests.set(response, request.originalUrl);
    response.on('close', () => pendingRequests.delete(response));
    state.requests.push(request.path);
    if (request.path.startsWith('/bundle/js/')) {
      state.bundleRequests.push(request.originalUrl);
      if (state.blockBundles) return response.status(503).end();
    }
    next();
  });
  for (const [url, file, type] of pages) {
    const filename = path.join(root, 'views', file);
    const template = fs.readFileSync(filename, 'utf8');
    app.get(url, (request, response) => response.type('html').send(ejs.render(template, {
      type, title: '', bundle: '/bundle', cachebuster: state.buildVersion
    }, {filename})));
  }
  const worker = fs.readFileSync(path.join(root, 'views/service-worker.js'), 'utf8');
  app.get('/sw.js', (request, response) => response.type('js').set('Cache-Control', 'no-store').send(ejs.render(worker, {locals: {cachebuster: state.workerVersion}})));
  app.get('/api/v1/status.json', (request, response) => {
    if (request.headers['api-secret'] !== hash) {state.challenges++; return response.status(401).json({message: 'Authentication required'});}
    if (state.loadingResponses > 0) {state.loadingResponses--; return response.json({...settings, runtimeState: 'loading'});}
    response.json(settings);
  });
  app.get('/api/v1/status.js', (request, response) => response.type('js').send('this.serverSettings = ' + JSON.stringify(settings) + ';'));
  app.get('/api/v1/verifyauth', (request, response) => {
    const authenticated = request.headers['api-secret'] === hash;
    response.json({message: {message: authenticated ? 'OK' : 'DENIED', isAdmin: authenticated, canRead: authenticated, canWrite: authenticated}});
  });
  app.get('/api/v1/adminnotifies', (request, response) => response.json({message: {notifies: [], notifyCount: 0}}));
  app.get('/translations/{*path}', (request, response) => response.json({}));
  app.get('/api/v1/food.json', (request, response) => {
    if (state.foodFailures > 0) {state.foodFailures--; return response.status(503).json({message: 'Temporarily unavailable'});}
    response.json(apiData(request));
  });
  app.get(['/api/v1/profile.json', '/api/v1/entries.json', '/api/v1/treatments.json',
    '/api/v1/food/regular.json', '/api/v1/profiles', '/api/v1/devicestatus.json'],
  (request, response) => response.json(apiData(request)));
  app.get(['/api/v2/authorization/subjects/', '/api/v2/authorization/roles/'], (request, response) => response.json(apiData(request)));
  app.post('/api/v1/food/', express.urlencoded({extended: false}), (request, response) => {
    state.foodWrites.push(request.body);
    response.json([{_id: '0123456789abcdef01234567'}]);
  });
  // Keep production styles and assets; replace only optional remote font
  // imports so the owned fixture never depends on an external service.
  const remoteFonts = [
    "@import url('https://fonts.googleapis.com/css?family=Ubuntu:400,700');",
    '@import url("//fonts.googleapis.com/css?family=Ubuntu:300,400,500,700,300italic,400italic,500italic,700italic");',
    '@import url("//fonts.googleapis.com/css?family=Open+Sans:300italic,400italic,600italic,700italic,300,400,600,700,800");'
  ];
  const css = new Map(['main', 'report'].map(name => ['/css/' + name + '.css',
    fs.readFileSync(path.join(root, 'static/css', name + '.css'), 'utf8').split('\n').filter(line => !remoteFonts.includes(line.trim())).join('\n')]));
  for (const [url, content] of css) app.get(url, (request, response) => response.type('css').send(content));
  app.use('/bundle', express.static(path.join(root, 'node_modules/.cache/_ns_cache/public')));
  app.use(express.static(path.join(root, 'static')));
  server = http.createServer(app);
  io = new Server(server, {pingInterval: 1000, pingTimeout: 5000});
  io.on('connection', socket => {
    socket.on('startup-probe', callback => callback({glucose: state.glucose}));
    socket.on('authorize', (data, callback) => {
      state.authorizations++;
      callback({read: true});
      socket.emit('dataUpdate', options.payload || {sgvs: [{mgdl: state.glucose, mills: Date.now(), direction: 'Flat', type: 'sgv'}], treatments: [], profiles: [], devicestatus: []});
    });
  });
  io.of('/alarm').on('connection', socket => socket.on('subscribe', (data, callback) => callback({success: true, read: true})));
  if (options.measureTraffic) server.prependListener('request', (request, response) => {
    // Run before Socket.IO and Express compression, counting encoded HTTP body
    // bytes at the final response write. Headers/chunk framing are excluded.
    const record = {path: new URL(request.url, 'http://fixture.test').pathname,
      method: request.method, bodyBytes: 0, completed: false};
    state.traffic.push(record);
    const write = response.write, end = response.end;
    const count = (chunk, encoding) => {
      if (typeof chunk === 'string') record.bodyBytes += Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : 'utf8');
      else if (ArrayBuffer.isView(chunk)) record.bodyBytes += chunk.byteLength;
    };
    response.write = function (chunk, encoding, callback) {count(chunk, encoding); return write.call(this, chunk, encoding, callback);};
    response.end = function (chunk, encoding, callback) {count(chunk, encoding); return end.call(this, chunk, encoding, callback);};
    response.once('finish', () => {
      record.completed = true; record.status = response.statusCode;
      record.encoding = response.getHeader('Content-Encoding') || 'identity';
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
  return {server, io, origin, state, pendingRequests};
}

module.exports = {createPageFixture, pages, hash};
