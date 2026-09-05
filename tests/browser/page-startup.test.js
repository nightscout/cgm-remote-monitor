'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const express = require('express');
const ejs = require('ejs');
const {Server} = require('socket.io');
const {withPage} = require('./fixture');
const {getBrowser} = require('./hooks');

describe('Complete page template startup', function () {
  let server, io, origin, requests, authorizations, glucose, foodWrites, challenges, foodFailures;
  const secret = 'this is my long pass phrase';
  const hash = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  const pages = [
    ['/', 'index.html', 'index', 'app'],
    ['/report/', 'reportindex.html', 'reports', 'reports'],
    ['/admin/', 'adminindex.html', 'admin', 'admin'],
    ['/profile', 'profileindex.html', 'profile', 'profile'],
    ['/food', 'foodindex.html', 'food', 'food']
  ];
  before(async function () {
    const root = path.resolve(__dirname, '../..');
    const app = express();
    const settings = structuredClone(require('../fixtures/default-server-settings'));
    settings.settings.enable += ' food';
    app.use((request, response, next) => {
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'");
      next();
    });
    app.use((request, response, next) => {requests.push(request.path); next();});
    for (const [url, file, type] of pages) {
      const filename = path.join(root, 'views', file);
      const html = ejs.render(fs.readFileSync(filename, 'utf8'), {
        type, title: '', bundle: '/bundle', cachebuster: 'page-startup'
      }, {filename});
      app.get(url, (request, response) => response.type('html').send(html));
    }
    app.get('/api/v1/status.json', (request, response) => {
      if (request.query.secret !== hash) {challenges++; return response.status(401).json({message: 'Authentication required'});}
      response.json(settings);
    });
    app.get('/api/v1/status.js', (request, response) => response.type('js').send('this.serverSettings = ' + JSON.stringify(settings) + ';'));
    app.get('/api/v1/verifyauth', (request, response) => {
      const authenticated = request.headers['api-secret'] === hash;
      response.json({message: {message: authenticated ? 'OK' : 'DENIED', isAdmin: authenticated, canRead: authenticated, canWrite: authenticated}});
    });
    app.get('/api/v1/adminnotifies', (request, response) => response.json({message: {notifies: [], notifyCount: 0}}));
    app.get('/translations/*', (request, response) => response.json({}));
    app.get('/api/v1/food.json', (request, response) => {
      if (foodFailures > 0) {foodFailures--; return response.status(503).json({message: 'Temporarily unavailable'});}
      response.json([]);
    });
    app.get(['/api/v1/profile.json', '/api/v1/entries.json', '/api/v1/treatments.json',
      '/api/v1/food/regular.json', '/api/v1/profiles', '/api/v1/devicestatus.json'],
    (request, response) => response.json([]));
    app.get(['/api/v2/authorization/subjects/', '/api/v2/authorization/roles/'], (request, response) => response.json([]));
    app.post('/api/v1/food/', express.urlencoded({extended: false}), (request, response) => {
      foodWrites.push(request.body);
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
      socket.on('startup-probe', callback => callback({glucose}));
      socket.on('authorize', (data, callback) => {
        authorizations++;
        callback({read: true});
        socket.emit('dataUpdate', {sgvs: [{mgdl: glucose, mills: Date.now(), direction: 'Flat', type: 'sgv'}], treatments: [], profiles: [], devicestatus: []});
      });
    });
    io.of('/alarm').on('connection', socket => socket.on('subscribe', (data, callback) => callback({success: true, read: true})));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () {if (io) await new Promise(resolve => io.close(resolve));});
  beforeEach(function () {requests = []; authorizations = 0; glucose = 123; foodWrites = []; challenges = 0; foodFailures = 0;});

  async function withNativePage(run) {
    // Use a native document origin for navigation with in-flight polling.
    // All routes are finite owned responses; CSP bounds subresource traffic.
    const context = await getBrowser().newContext({serviceWorkers: 'block', acceptDownloads: false});
    const external = [], errors = [];
    context.on('request', request => {if (new URL(request.url()).origin !== origin) external.push(request.url());});
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      await run({page});
      assert.deepEqual(external, [], 'Unexpected external request');
      assert.deepEqual(errors, [], 'Uncaught browser errors');
    } finally {await context.close();}
  }

  for (const authenticate of [false, true]) {
  for (const [url, , , entry] of pages) {
    it('boots ' + entry + ' with ' + (authenticate ? 'the authentication dialog' : 'stored authentication') + ' and reconnects twice', async function () {
      await withPage(origin, async ({page}) => {
        if (!authenticate) await page.addInitScript(hash => localStorage.setItem('apisecrethash', hash), hash);
        try {
          await page.goto(origin + url);
          if (authenticate) {
            await page.locator('#apisecret').fill(secret);
            await page.locator('#requestauthenticationdialog-btn').click();
          }
          await page.waitForFunction(() => window.Nightscout && window.Nightscout.client.socket && window.Nightscout.client.socket.connected);
          await page.waitForFunction(entry => {
            if (entry === 'app') return document.querySelector('.currentBG').textContent.trim() === '123';
            if (entry === 'reports') return !!window.Nightscout.report_plugins;
            if (entry === 'admin') return document.querySelector('#admin_placeholder').children.length > 0;
            if (entry === 'profile') return /Values loaded|Default values used/.test(document.querySelector('.pe_status').textContent);
            return document.querySelector('#fe_status').textContent === 'Database loaded';
          }, entry);
          assert.ok(authorizations >= 1);
          assert.equal(challenges, authenticate ? 1 : 0);
          assert.equal(await page.evaluate(() => window.Nightscout.client.hashauth.isAuthenticated()), true);
          assert.equal(await page.locator('#page-load-error').isVisible(), false);
          assert.deepEqual(requests.filter(value => /^\/bundle\/js\/bundle\..*\.js$/.test(value)),
            entry === 'app' ? ['/bundle/js/bundle.app.js'] : ['/bundle/js/bundle.app.js', '/bundle/js/bundle.' + entry + '.js']);
          const controls = await page.locator('button, input, select, option').count();
          const draft = entry === 'food' ? '#fe_name' : entry === 'reports' ? '#rp_from' : entry === 'profile' ? '#pe_date' : null;
          const draftValue = entry === 'food' ? 'Unsaved food draft' : '2026-01-02';
          if (draft) await page.locator(draft).fill(draftValue);
          for (let cycle = 0; cycle < 2; cycle++) {
            const before = authorizations;
            glucose++;
            await page.evaluate(() => window.Nightscout.client.socket.io.engine.close());
            await page.waitForFunction(value => window.Nightscout.client.latestSGV && window.Nightscout.client.latestSGV.mgdl === value, glucose);
            assert.equal(authorizations, before + 1, 'One authorization after reconnect');
            assert.equal(io.of('/').sockets.size, 1, 'One active data connection');
            assert.equal(await page.locator('button, input, select, option').count(), controls, 'Reconnect must not duplicate controls');
            if (draft) assert.equal(await page.locator(draft).inputValue(), draftValue, 'Reconnect preserves unsaved form input');
          }
          if (entry === 'food') {
            await page.locator('#fe_carbs').fill('10');
            await page.locator('#fe_portion').fill('1');
            await page.locator('#fe_editcreate').click();
            await page.waitForFunction(() => document.querySelector('#fe_status').textContent === 'OK' && window.$.active === 0);
            assert.equal(foodWrites.length, 1, 'One save action must create exactly one record after reconnects');
            assert.equal(foodWrites[0].name, draftValue);
          }
        } finally {
          await page.evaluate(() => {
            const client = window.Nightscout && window.Nightscout.client;
            if (client && client.socket) client.socket.disconnect();
            if (client && client.alarmSocket) client.alarmSocket.disconnect();
          });
        }
      });
    });
  }
  }

  it('retries a failed initial food fetch on reconnect without duplicating later save actions', async function () {
    foodFailures = 1;
    await withPage(origin, async ({page}) => {
      await page.addInitScript(hash => localStorage.setItem('apisecrethash', hash), hash);
      try {
        await page.goto(origin + '/food');
        await page.waitForFunction(() => document.querySelector('#fe_status').textContent === 'Error: Database failed to load');
        for (let cycle = 0; cycle < 2; cycle++) {
          glucose++;
          await page.evaluate(() => window.Nightscout.client.socket.io.engine.close());
          await page.waitForFunction(value => window.Nightscout.client.latestSGV && window.Nightscout.client.latestSGV.mgdl === value, glucose);
          await page.waitForFunction(() => document.querySelector('#fe_status').textContent === 'Database loaded');
        }
        assert.equal(requests.filter(url => url === '/api/v1/food.json').length, 2);
        await page.locator('#fe_name').fill('Recovered food');
        await page.locator('#fe_carbs').fill('10');
        await page.locator('#fe_portion').fill('1');
        await page.locator('#fe_editcreate').click();
        await page.waitForFunction(() => document.querySelector('#fe_status').textContent === 'OK' && window.$.active === 0);
        assert.equal(foodWrites.length, 1);
        assert.equal(foodWrites[0].name, 'Recovered food');
      } finally {
        await page.evaluate(() => {
          const client = window.Nightscout.client;
          if (client.socket) client.socket.disconnect();
          if (client.alarmSocket) client.alarmSocket.disconnect();
        });
      }
    });
  });

  it('opens each page from the dashboard and returns through its close link', async function () {
    await withNativePage(async ({page}) => {
      await page.addInitScript(hash => localStorage.setItem('apisecrethash', hash), hash);
      await page.goto(origin);
      await page.waitForFunction(() => document.querySelector('.currentBG').textContent.trim() === '123');
      try {
        for (const [id, pathname] of [['reportlink', '/report'], ['editprofilelink', '/profile'], ['editfoodlink', '/food'], ['admintoolslink', '/admin']]) {
          await page.locator('#drawerToggle').click();
          const [opened, clicked] = await Promise.allSettled([page.waitForEvent('popup'), page.locator('#' + id).click()]);
          assert.equal(clicked.status, 'fulfilled', id + ': ' + (clicked.reason && clicked.reason.message));
          assert.equal(opened.status, 'fulfilled', id + ': ' + (opened.reason && opened.reason.message));
          const child = opened.value;
          try {
            await child.waitForLoadState();
            await child.waitForFunction(() => window.Nightscout && window.Nightscout.client.socket && window.Nightscout.client.socket.connected);
            assert.equal(new URL(child.url()).pathname.replace(/\/$/, ''), pathname);
            assert.equal(await child.locator('#page-load-error').isVisible(), false);
            await child.locator('.closeButton').click();
            await child.waitForFunction(() => document.querySelector('.currentBG') && document.querySelector('.currentBG').textContent.trim() === '123');
            assert.equal(new URL(child.url()).pathname, '/');
            for (let cycle = 0; cycle < 2; cycle++) {
              await child.goBack();
              await child.waitForFunction(() => window.Nightscout && window.Nightscout.client.socket && window.Nightscout.client.socket.connected);
              const reply = await child.evaluate(() => new Promise((resolve, reject) => {
                window.Nightscout.client.socket.timeout(3000).emit('startup-probe', (error, data) => error ? reject(error) : resolve(data));
              }));
              assert.deepEqual(reply, {glucose: 123}, 'Back navigation restores a live data connection');
              await child.goForward();
              await child.waitForFunction(() => document.querySelector('.currentBG') && document.querySelector('.currentBG').textContent.trim() === '123');
            }
          } finally {
            await child.evaluate(() => {
              const client = window.Nightscout && window.Nightscout.client;
              if (client && client.socket) client.socket.disconnect();
              if (client && client.alarmSocket) client.alarmSocket.disconnect();
            });
            await child.close();
          }
        }
      } finally {
        await page.evaluate(() => {
          const client = window.Nightscout.client;
          client.socket.disconnect(); client.alarmSocket.disconnect();
        });
      }
    });
  });
});
