'use strict';

const assert = require('node:assert/strict');
const selectedWidgetsReady = require('./ui-widget-probe');
const {withPage} = require('./fixture');
const {getBrowser} = require('./hooks');
const {createPageFixture, pages, hash} = require('../fixtures/page-startup/server');

describe('Complete page template startup', function () {
  let io, origin, fixtureState, pendingRequests;
  const secret = 'this is my long pass phrase';
  before(async function () {({io, origin, state: fixtureState, pendingRequests} = await createPageFixture());});
  after(async function () {if (io) await new Promise(resolve => io.close(resolve));});
  function disconnected(peer) {
    if (!peer || !peer.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {peer.off('disconnect', done); reject(new Error('Socket did not retire within its heartbeat deadline: ' + peer.id));}, 7000);
      function done() {clearTimeout(timer); resolve();}
      peer.once('disconnect', done);
    });
  }
  afterEach(async function () {
    this.timeout(8000);
    // A browser closing its transport may not deliver the close packet. Wait
    // for the configured 1s heartbeat + 5s timeout before the next test owns
    // this server; retain the assertion that all peers actually disappear.
    await Promise.all([...io.of('/').sockets.values(), ...io.of('/alarm').sockets.values()].map(disconnected));
    assert.equal(io.of('/').sockets.size, 0);
    assert.equal(io.of('/alarm').sockets.size, 0);
  });
  beforeEach(function () {
    fixtureState.requests = []; fixtureState.authorizations = 0; fixtureState.glucose = 123; fixtureState.foodWrites = []; fixtureState.challenges = 0; fixtureState.foodFailures = 0; fixtureState.loadingResponses = 0;
    fixtureState.buildVersion = fixtureState.workerVersion = 'page-startup'; fixtureState.blockBundles = false; fixtureState.bundleRequests = [];
  });

  function readyEntry(entry) {
    if (entry === 'app') return document.querySelector('.currentBG').textContent.trim() === '123';
    if (entry === 'reports') return !!window.Nightscout.report_plugins;
    if (entry === 'admin') return document.querySelector('#admin_placeholder').children.length > 0;
    if (entry === 'profile') return /Values loaded|Default values used/.test(document.querySelector('.pe_status').textContent);
    return document.querySelector('#fe_status').textContent === 'Database loaded';
  }

  async function withNativePage(run, {serviceWorkers = 'block'} = {}) {
    // Use a native document origin for navigation with in-flight polling.
    // All routes are finite owned responses; CSP bounds subresource traffic.
    const context = await getBrowser().newContext({serviceWorkers, acceptDownloads: false});
    const external = [], errors = [], messages = [];
    context.on('console', message => {messages.push(message.text()); if (messages.length > 30) messages.shift();});
    context.on('request', request => {if (new URL(request.url()).origin !== origin) external.push(request.url());});
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      page.setDefaultNavigationTimeout(5000);
      await run({page});
      assert.deepEqual(external, [], 'Unexpected external request');
      assert.deepEqual(errors, [], 'Uncaught browser errors');
    } catch (error) {error.message += '\nBrowser messages: ' + JSON.stringify(messages); throw error;}
    finally {await context.close();}
  }

  for (const authenticate of [false, true]) {
  for (const [url, , , entry] of pages) {
    it('boots ' + entry + ' with ' + (authenticate ? 'the authentication dialog' : 'stored authentication') + ' and reconnects twice', async function () {
      await withPage(origin, async ({page}) => {
        const statusUrls = [];
        page.on('request', request => {if (new URL(request.url()).pathname === '/api/v1/status.json') statusUrls.push(request.url());});
        if (!authenticate) await page.addInitScript(hash => localStorage.setItem('apisecrethash', hash), hash);
        try {
          await page.goto(origin + url);
          if (authenticate) {
            await page.locator('#apisecret').fill(secret);
            await page.locator('#requestauthenticationdialog-btn').click();
          }
          await page.waitForFunction(() => window.Nightscout && window.Nightscout.client.socket && window.Nightscout.client.socket.connected);
          await page.waitForFunction(readyEntry, entry);
          assert.ok(fixtureState.authorizations >= 1);
          assert.equal(fixtureState.challenges, authenticate ? 1 : 0);
          assert.equal(await page.evaluate(() => window.Nightscout.client.hashauth.isAuthenticated()), true);
          assert.equal(await page.locator('#page-load-error').isVisible(), false);
          const expectedBundles = entry === 'app' ? ['/bundle/js/bundle.app.js'] : ['/bundle/js/bundle.app.js', '/bundle/js/bundle.' + entry + '.js'];
          // The preload scanner can start downloads out of order. Check exact
          // request counts independently from the ordered parser script tags.
          assert.deepEqual(fixtureState.requests.filter(value => /^\/bundle\/js\/bundle\..*\.js$/.test(value)).sort(), expectedBundles.slice().sort());
          assert.deepEqual(await page.locator('script[src]').evaluateAll(scripts => scripts.map(script => new URL(script.src).pathname).filter(value => /^\/bundle\/js\/bundle\..*\.js$/.test(value))), expectedBundles);
          const controls = await page.locator('button, input, select, option').count();
          const draft = entry === 'food' ? '#fe_name' : entry === 'reports' ? '#rp_from' : entry === 'profile' ? '#pe_date' : null;
          const draftValue = entry === 'food' ? 'Unsaved food draft' : '2026-01-02';
          if (draft) await page.locator(draft).fill(draftValue);
          for (let cycle = 0; cycle < 2; cycle++) {
            const before = fixtureState.authorizations;
            const oldId = await page.evaluate(() => window.Nightscout.client.socket.id);
            const oldPeer = io.of('/').sockets.get(oldId);
            fixtureState.glucose++;
            await Promise.all([
              disconnected(oldPeer),
              (async () => {
                await page.evaluate(() => window.Nightscout.client.socket.io.engine.close());
                await page.waitForFunction(value => window.Nightscout.client.latestSGV && window.Nightscout.client.latestSGV.mgdl === value, fixtureState.glucose);
              })()
            ]);
            assert.equal(fixtureState.authorizations, before + 1, 'One authorization after reconnect');
            assert.equal(io.of('/').sockets.size, 1, 'One active data connection');
            assert.equal(await page.locator('button, input, select, option').count(), controls, 'Reconnect must not duplicate controls');
            if (draft) assert.equal(await page.locator(draft).inputValue(), draftValue, 'Reconnect preserves unsaved form input');
          }
          if (entry === 'food') {
            await page.locator('#fe_carbs').fill('10');
            await page.locator('#fe_portion').fill('1');
            await page.locator('#fe_editcreate').click();
            await page.waitForFunction(() => document.querySelector('#fe_status').textContent === 'OK' && window.$.active === 0);
            assert.equal(fixtureState.foodWrites.length, 1, 'One save action must create exactly one record after reconnects');
            assert.equal(fixtureState.foodWrites[0].name, draftValue);
          }
          assert(statusUrls.length > 0);
          for (const url of statusUrls) {
            const params = new URL(url).searchParams;
            assert.equal(params.has('secret'), false);
            assert.equal(params.has('token'), false);
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

  for (const state of ['loading', 'offline']) {
    for (const [url, , , entry] of pages) {
      it('recovers ' + entry + ' after two ' + state + ' startup responses', async function () {
        let attempts = 0;
        if (state === 'loading') fixtureState.loadingResponses = 2;
        await withPage(origin, async ({page}) => {
          await page.addInitScript(hash => localStorage.setItem('apisecrethash', hash), hash);
          await page.route(url => url.origin === origin && url.pathname === '/api/v1/status.json', route => {
            attempts++;
            return state === 'offline' && attempts <= 2 ? route.abort('failed') : route.fallback();
          });
          await page.clock.install();
          try {
            await page.goto(origin + url);
            const message = state === 'loading' ? 'Nightscout is still starting' : 'Connecting to Nightscout server failed';
            for (let retry = 0; retry < 2; retry++) {
              await page.waitForFunction(message => window.$ && window.$.active === 0 && document.querySelector('#loadingMessageText') && document.querySelector('#loadingMessageText').textContent.includes(message), message);
              assert.equal(await page.locator('#loadingMessageText').isVisible(), true);
              assert.equal(attempts, retry + 1);
              assert.equal(fixtureState.authorizations, 0, 'No socket initialization before status is ready');
              const next = page.waitForRequest(url => new URL(url.url()).pathname === '/api/v1/status.json');
              await page.clock.runFor(5000);
              await next;
            }
            await page.waitForFunction(readyEntry, entry);
            assert.equal(attempts, 3);
            assert.equal(fixtureState.authorizations, 1);
            assert.equal(await page.locator('#centerMessagePanel').isVisible(), false);
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

  for (const [url, , , entry] of pages) {
    it('recovers the actual ' + entry + ' page after two failed bundle downloads', async function () {
      await withPage(origin, async ({page}) => {
        await page.addInitScript(hash => localStorage.setItem('apisecrethash', hash), hash);
        try {
          for (let cycle = 0; cycle < 2; cycle++) {
            fixtureState.blockBundles = true;
            await page.goto(origin + url);
            const retry = page.getByRole('button', {name: 'Reload page'});
            await retry.waitFor({state: 'visible'});
            assert.equal(await page.locator('#centerMessagePanel').isVisible(), false, 'Loading overlay must not obscure recovery');
            const before = fixtureState.authorizations;
            fixtureState.blockBundles = false;
            await Promise.all([page.waitForEvent('load'), retry.press('Enter')]);
            await page.waitForFunction(readyEntry, entry);
            assert.equal(fixtureState.authorizations, before + 1);
            assert.equal(await page.locator('#page-load-error').isVisible(), false);
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

  it('retries a failed initial food fetch on reconnect without duplicating later save actions', async function () {
    fixtureState.foodFailures = 1;
    await withPage(origin, async ({page}) => {
      await page.addInitScript(hash => localStorage.setItem('apisecrethash', hash), hash);
      try {
        await page.goto(origin + '/food');
        await page.waitForFunction(() => document.querySelector('#fe_status').textContent === 'Error: Database failed to load');
        for (let cycle = 0; cycle < 2; cycle++) {
          fixtureState.glucose++;
          await page.evaluate(() => window.Nightscout.client.socket.io.engine.close());
          await page.waitForFunction(value => window.Nightscout.client.latestSGV && window.Nightscout.client.latestSGV.mgdl === value, fixtureState.glucose);
          await page.waitForFunction(() => document.querySelector('#fe_status').textContent === 'Database loaded');
        }
        assert.equal(fixtureState.requests.filter(url => url === '/api/v1/food.json').length, 2);
        await page.locator('#fe_name').fill('Recovered food');
        await page.locator('#fe_carbs').fill('10');
        await page.locator('#fe_portion').fill('1');
        await page.locator('#fe_editcreate').click();
        await page.waitForFunction(() => document.querySelector('#fe_status').textContent === 'OK' && window.$.active === 0);
        assert.equal(fixtureState.foodWrites.length, 1);
        assert.equal(fixtureState.foodWrites[0].name, 'Recovered food');
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

  it('boots every page from cached bundles and retires the old cache on upgrade', async function () {
    await withNativePage(async ({page}) => {
      await page.addInitScript(hash => localStorage.setItem('apisecrethash', hash), hash);
      let navigations = 0;
      let stage = 'initial installation';
      page.on('framenavigated', frame => {if (frame === page.mainFrame()) navigations++;});
      try {
        await page.goto(origin);
        await page.evaluate(() => {navigator.serviceWorker.ready.then(() => {window.workerReady = true;});});
        await page.waitForFunction(() => window.workerReady === true);
        await page.waitForFunction(readyEntry, 'app');
        assert.equal(navigations, 1, 'Initial worker installation must not reload a starting page');
        stage = 'first controlled navigation';
        await page.goto(origin + '/report/');
        await page.waitForFunction(() => !!navigator.serviceWorker.controller);
        stage = 'first visits';
        for (const [url, , , entry] of pages) {
          await page.goto(origin + url);
          await page.waitForFunction(readyEntry, entry);
        }
        const cached = await page.evaluate(async () => (await (await caches.open('page-startup')).keys()).map(request => new URL(request.url).pathname));
        for (const entry of ['app', 'reports', 'admin', 'profile', 'food']) assert.ok(cached.includes('/bundle/js/bundle.' + entry + '.js'));

        fixtureState.blockBundles = true; fixtureState.bundleRequests = [];
        stage = 'cached visits';
        for (const [url, , , entry] of pages) {
          await page.goto(origin + url);
          await page.waitForFunction(readyEntry, entry);
          assert.equal(await page.locator('#page-load-error').isVisible(), false);
          assert.equal(await page.evaluate(selectedWidgetsReady), true, entry + ' lost UI widgets or inline CSS when using cached bundles');
        }
        assert.deepEqual(fixtureState.bundleRequests, [], 'Cached application bundles must boot without an origin download');

        fixtureState.blockBundles = false; fixtureState.buildVersion = 'page-upgrade'; fixtureState.bundleRequests = [];
        stage = 'new document under old worker';
        await page.goto(origin + '/report/');
        await page.waitForFunction(readyEntry, 'reports');
        assert.ok(fixtureState.bundleRequests.includes('/bundle/js/bundle.app.js?v=page-upgrade'));
        assert.ok(fixtureState.bundleRequests.includes('/bundle/js/bundle.reports.js?v=page-upgrade'));
        stage = 'worker upgrade';
        // Keep the old worker response stable while proving new-document cache
        // bypass. Browsers may check for worker updates on any navigation.
        await page.goto(origin);
        await page.waitForFunction(readyEntry, 'app');
        assert.equal(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), true, 'Dashboard is controlled before worker update');
        const beforeUpdate = navigations;
        fixtureState.workerVersion = fixtureState.buildVersion;
        await Promise.all([
          page.waitForEvent('framenavigated', {predicate: frame => frame === page.mainFrame()}),
          // The expected controllerchange reload destroys the outgoing realm;
          // observe navigation instead of awaiting update() in that realm.
          page.evaluate(() => {
            navigator.serviceWorker.getRegistration().then(registration => registration.update())
              .catch(error => console.error('Worker update failed:', error.message));
          })
        ]);
        await page.waitForLoadState('load');
        await page.waitForFunction(async () => {
          const names = await caches.keys();
          return names.includes('page-upgrade') && !names.includes('page-startup');
        });
        await page.waitForFunction(readyEntry, 'app');
        assert.equal(navigations, beforeUpdate + 1, 'Exactly one automatic reload when the active dashboard worker updates');
        stage = 'visits after upgrade';
        for (const [url, , , entry] of pages) {
          stage = 'visits after upgrade: ' + entry;
          await page.goto(origin + url);
          await page.waitForFunction(readyEntry, entry);
        }
      } catch (error) {
        error.message = 'Application worker stage ' + stage + ': ' + error.message;
        error.message += '\nPage URL: ' + page.url();
        error.message += '\nPending HTTP: ' + JSON.stringify([...pendingRequests.values()]);
        throw error;
      }
    }, {serviceWorkers: 'allow'});
  });
});
