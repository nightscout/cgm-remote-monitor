'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const express = require('express');
const ejs = require('ejs');
const {withPage} = require('./fixture');

const profileData = {
  defaultProfile: 'Default', units: 'mg/dl', store: {Default: {
    dia: 3, units: 'mg/dl', basal: [{time: '00:00', timeAsSeconds: 0, value: 1}],
    carbratio: [{time: '00:00', timeAsSeconds: 0, value: 10}],
    sens: [{time: '00:00', timeAsSeconds: 0, value: 50}],
    target_low: [{time: '00:00', timeAsSeconds: 0, value: 100}],
    target_high: [{time: '00:00', timeAsSeconds: 0, value: 120}]
  }}
};

const emptyFailureMessage = 'Nightscout returned an error without details. Check Loop before submitting again, and ask the Nightscout administrator to check the server logs.';
const connectionFailureMessage = 'Could not confirm whether Loop received this command. Check your connection and Loop before submitting it again.';
const authorizationFailureMessage = 'Authorization failed. Reauthorize Nightscout access or ask the administrator to check your Loop command permissions.';

describe('careportal in a real browser', function () {
  let server, origin, requests, loopResponse, markup;
  before(async function () {
    const root = path.resolve(__dirname, '../..');
    const file = path.join(root, 'views/index.html');
    markup = ejs.render(fs.readFileSync(file, 'utf8'), {type: 'index', title: '', bundle: '/bundle'}, {filename: file});
    const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/css/main.css"></head><body></body></html>';
    const css = fs.readFileSync(path.join(root, 'static/css/main.css'), 'utf8')
      .replace("@import url('https://fonts.googleapis.com/css?family=Ubuntu:400,700');", '');
    const settings = structuredClone(require('../fixtures/default-server-settings'));
    settings.settings.showPlugins = 'iob careportal boluscalc';
    settings.settings.enable += ' boluscalc';
    const app = express();
    app.use(express.urlencoded({extended: true}));
    app.use((request, response, next) => {
      if (request.path.startsWith('/api/') || request.path.startsWith('/translations/')) {
        requests.push({method: request.method, path: request.path, query: request.query, data: request.body});
      }
      next();
    });
    app.get('/', (request, response) => response.type('html').send(html));
    app.get('/api/v1/status.json', (request, response) => response.json(settings));
    app.get('/api/v1/verifyauth', (request, response) => response.json({message: 'OK'}));
    app.get('/api/v1/adminnotifies', (request, response) => response.json({message: {notifies: [], notifyCount: 0}}));
    app.get('/translations/*', (request, response) => response.json({}));
    app.post('/api/v1/treatments/', (request, response) => response.json({message: 'OK'}));
    app.post('/api/v2/notifications/loop', (request, response) => {
      const {status, body, delay} = loopResponse;
      const send = () => response.status(status).type('text').send(body);
      if (delay) {
        const timer = setTimeout(send, delay);
        response.once('close', () => clearTimeout(timer));
      } else send();
    });
    app.get('/css/main.css', (request, response) => response.type('css').send(css));
    app.use('/bundle', express.static(path.join(root, 'node_modules/.cache/_ns_cache/public')));
    app.use(express.static(path.join(root, 'static')));
    server = http.createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
  });

  async function withApp(run, {timezoneId = 'UTC', now = '2024-10-26T04:00:00Z', profile = false} = {}) {
    requests = [];
    loopResponse = {status: 200, body: 'OK'};
    await withPage(origin, async ({page}) => {
      const dialogs = [];
      page.on('dialog', async dialog => {
        dialogs.push({type: dialog.type(), message: dialog.message()});
        await dialog.accept();
      });
      await page.clock.setFixedTime(new Date(now));
      await page.goto(origin);
      await page.evaluate(markup => {
        // Parse the trusted production template inertly, then move its body
        // nodes into the fixture. Boot manually after installing finite socket
        // responses; service workers and audio are outside this form suite.
        const parsed = new DOMParser().parseFromString(markup, 'text/html');
        parsed.querySelectorAll('script').forEach(script => script.remove());
        parsed.querySelectorAll('audio').forEach(audio => {audio.preload = 'none';});
        document.body.replaceChildren(...parsed.body.childNodes);
      }, markup);
      await page.addScriptTag({url: origin + '/bundle/js/bundle.app.js'});
      await page.evaluate(() => {
        const state = window.careportalFixture = {sockets: [], emitted: [], posts: [], closed: [], failures: []};
        window.io = {connect() {
          const socket = {
            on(event, callback) {if (event === 'connect') queueMicrotask(callback); return socket;},
            emit(event, data, callback) {
              state.emitted.push({event, data});
              if (callback) callback({read: true});
              return socket;
            }
          };
          state.sockets.push(socket);
          return socket;
        }};
        window.$.ajaxPrefilter((options, original, jqXHR) => {
          if (options.url === '/api/v2/notifications/loop') {
            jqXHR.fail((xhr, textStatus) => state.failures.push({status: xhr.status, textStatus}));
          }
          if (options.url === '/api/v1/treatments/') {
            const data = original.data;
            state.posts.push({eventType: data.eventType, created_at: data.created_at,
              eventTimeType: Object.prototype.toString.call(data.eventTime), eventTime: data.eventTime?.toISOString(),
              boluscalc: data.boluscalc ? JSON.parse(JSON.stringify(data.boluscalc)) : undefined});
          }
        });
        return new Promise(resolve => window.Nightscout.client.init(resolve));
      });
      await page.waitForFunction(() => window.$.active === 0 && window.Nightscout.client.hashauth.isAuthenticated());
      await page.evaluate(({profile, record}) => {
        const client = window.Nightscout.client;
        const data = {sgvs: [{mgdl: 100, mills: Date.now(), direction: 'Flat', type: 'sgv'}], treatments: []};
        if (profile) Object.assign(data, {devicestatus: [], profiles: [record]});
        client.dataUpdate(data);
        const close = client.browserUtils.closeDrawer;
        client.browserUtils.closeDrawer = function (selector) {
          window.careportalFixture.closed.push(selector);
          return close.apply(this, arguments);
        };
      }, {profile, record: profileData});
      assert.equal(requests.filter(r => r.path === '/api/v1/status.json').length, 1);
      assert.equal(requests.filter(r => r.path.startsWith('/translations/')).length, 1);
      assert.equal(requests.filter(r => r.path === '/api/v1/verifyauth').length, 1);
      assert.deepEqual(await page.evaluate(() => ({sockets: window.careportalFixture.sockets.length,
        auth: window.careportalFixture.emitted.filter(e => e.event === 'authorize').length,
        chart: !!window.Nightscout.client.chart, units: window.Nightscout.client.settings.units})),
      {sockets: 2, auth: 1, chart: true, units: 'mg/dl'});
      await run({page, dialogs});
    }, {timezoneId});
  }

  async function openCareportal(page) {
    await page.locator('#treatmentDrawerToggle').click();
    await page.locator('#eventType').waitFor({state: 'visible'});
  }

  async function submit(page, selector = '#treatmentDrawer button') {
    await page.locator(selector).click();
    await page.waitForFunction(() => window.$.active === 0);
  }

  it('open careportal, and enter a treatment', async function () {
    await withApp(async ({page, dialogs}) => {
      await openCareportal(page);
      await page.locator('#eventType').selectOption('Snack Bolus');
      await page.locator('#glucoseValue').fill('100');
      await page.locator('#carbsGiven').fill('10');
      await page.locator('#insulinGiven').fill('0.60');
      await page.locator('#preBolus').selectOption('15');
      await page.locator('#notes').fill('Testing');
      await page.locator('#enteredBy').fill('Dad');
      await page.evaluate(() => {
        const portal = window.Nightscout.client.careportal;
        portal.eventTimeTypeChange(); portal.dateTimeFocus(); portal.dateTimeChange();
      });
      await submit(page);
      assert.deepEqual(dialogs.map(d => d.type), ['confirm']);
      for (const line of ['Event Type: Snack Bolus', 'Blood Glucose: 100', 'Carbs Given: 10', 'Insulin Given: 0.60', 'Carb Time: 15 mins', 'Notes: Testing', 'Entered By: Dad']) {
        assert.ok(dialogs[0].message.indexOf(line + '\n') > 0, line);
      }
      const posts = requests.filter(r => r.path === '/api/v1/treatments/');
      assert.equal(posts.length, 1);
      assert.equal(posts[0].method, 'POST');
      assert.equal(posts[0].data.eventType, 'Snack Bolus');
    });
  });

  for (const testCase of [
    {time: '2024-10-25T23:00:00-05:00', timezoneId: 'America/Chicago', date: '2024-10-25', timeInput: '23:00', expected: '2024-10-26T04:00:00.000Z', wrong: '2024-10-27T04:00:00.000Z'},
    {time: '2024-10-26T01:00:00+03:00', timezoneId: 'Europe/Moscow', date: '2024-10-26', timeInput: '01:00', expected: '2024-10-25T22:00:00.000Z', wrong: '2024-10-24T22:00:00.000Z'}
  ]) {
    it('uses local timezone date, not UTC, when saving an other-time treatment (8304) ' + testCase.time, async function () {
      await withApp(async ({page, dialogs}) => {
        await openCareportal(page);
        assert.equal(await page.locator('#eventDateValue').inputValue(), testCase.date);
        assert.equal(await page.locator('#eventTimeValue').inputValue(), testCase.timeInput);
        await page.locator('#eventType').selectOption('BG Check');
        await page.locator('#glucoseValue').fill('100');
        await page.locator('#othertime').check();
        await submit(page);
        assert.deepEqual(dialogs.map(d => d.type), ['confirm']);
        const posts = requests.filter(r => r.path === '/api/v1/treatments/');
        assert.equal(posts.length, 1);
        assert.equal(posts[0].data.eventType, 'BG Check');
        assert.equal(posts[0].data.created_at, testCase.expected);
        assert.notEqual(posts[0].data.created_at, testCase.wrong);
      }, {timezoneId: testCase.timezoneId, now: testCase.time});
    });
  }

  it('uses local timezone date, not UTC, when saving a boluscalc other-time treatment', async function () {
    await withApp(async ({page, dialogs}) => {
      await page.locator('#boluscalcDrawerToggle').click();
      assert.equal(await page.locator('#bc_eventDateValue').inputValue(), '2024-10-26');
      assert.equal(await page.locator('#bc_eventTimeValue').inputValue(), '01:00');
      await page.locator('#bc_bg').fill('100');
      await page.locator('#bc_carbs').fill('10');
      await page.locator('#bc_othertime').check();
      await submit(page, '#boluscalcDrawer button');
      assert.deepEqual(dialogs.map(d => d.type), ['confirm']);
      const posts = requests.filter(r => r.path === '/api/v1/treatments/');
      assert.equal(posts.length, 1);
      const recorded = await page.evaluate(() => window.careportalFixture.posts);
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0].eventType, 'Bolus Wizard');
      assert.equal(recorded[0].eventTimeType, '[object Date]');
      assert.equal(recorded[0].eventTime, '2024-10-25T22:00:00.000Z');
      assert.equal(recorded[0].boluscalc.eventTime, '2024-10-25T22:00:00.000Z');
      assert.notEqual(recorded[0].boluscalc.eventTime, '2024-10-24T22:00:00.000Z');
      assert.equal(posts[0].data.eventType, 'Bolus Wizard');
      assert.equal(new Date(posts[0].data.eventTime).toISOString(), '2024-10-25T22:00:00.000Z');
      assert.equal(posts[0].data.boluscalc.eventTime, '2024-10-25T22:00:00.000Z');
    }, {timezoneId: 'Europe/Moscow', now: '2024-10-26T01:00:00+03:00', profile: true});
  });

  async function checkLoopSubmission(eventType, failure, expectedMessage, mode) {
    await withApp(async ({page, dialogs}) => {
      const aborted = [];
      if (mode === 'connection') {
        await page.route(origin + '/api/v2/notifications/loop', async route => {
          aborted.push({method: route.request().method(), data: Object.fromEntries(new URLSearchParams(route.request().postData()))});
          await route.abort('connectionfailed');
        });
      } else if (mode === 'timeout') {
        loopResponse = {status: 200, body: 'OK', delay: 2000};
        await page.evaluate(() => window.$.ajaxPrefilter(options => {
          if (options.url === '/api/v2/notifications/loop') options.timeout = 1000;
        }));
      } else if (failure) loopResponse = {status: failure.status, body: failure.responseText};
      await page.evaluate(({failure, mode}) => {
        const client = window.Nightscout.client, $ = window.$;
        const loopEvents = client.plugins('loop').getEventTypes({settings: client.settings,
          data: {profile: {data: [{loopSettings: {overridePresets: [{name: 'test-override', symbol: '', duration: 1800}]}}]}}});
        const original = client.plugins.getAllEventTypes;
        client.plugins.getAllEventTypes = function (sbx) {return original.call(client.plugins, sbx).concat(loopEvents);};
        window.careportalFixture.injectedRequests = [];
        if (mode === 'malformed') {
          const ajax = $.ajax;
          // Native XHR responseText is always a string. Retain the two legacy
          // malformed-callback checks at this narrow boundary, not as fake HTTP.
          $.ajax = function (options) {
            if (options.url !== '/api/v2/notifications/loop') return ajax.apply(this, arguments);
            window.careportalFixture.injectedRequests.push({method: options.method, data: options.data});
            return $.Deferred().reject(failure, 'error').promise();
          };
        }
      }, {failure, mode});
      await openCareportal(page);
      await page.locator('#eventType').selectOption(eventType);
      // Preserve the legacy inputs, including fields not shown for this command.
      await page.evaluate(() => {
        const $ = window.$;
        $('#reason').val('test-override'); $('#remoteCarbs').val('10'); $('#remoteBolus').val('1');
      });
      await page.locator('#notes').fill('Keep these notes');
      await page.locator('#enteredBy').fill('Test user');
      await submit(page);
      const state = await page.evaluate(() => ({closed: window.careportalFixture.closed,
        injected: window.careportalFixture.injectedRequests, failures: window.careportalFixture.failures, eventType: window.$('#eventType').val(),
        notes: window.$('#notes').val(), enteredBy: window.$('#enteredBy').val(),
        carbs: window.$('#remoteCarbs').val(), bolus: window.$('#remoteBolus').val()}));
      const sent = mode === 'malformed' ? state.injected : mode === 'connection' ? aborted : requests.filter(r => r.path === '/api/v2/notifications/loop');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].method, 'POST');
      assert.equal(sent[0].data.eventType, eventType);
      if (mode === 'timeout' || mode === 'connection') {
        assert.deepEqual(state.failures, [{status: 0, textStatus: mode === 'timeout' ? 'timeout' : 'error'}]);
      } else if (failure && mode !== 'malformed') {
        assert.deepEqual(state.failures, [{status: failure.status, textStatus: 'error'}]);
      } else assert.deepEqual(state.failures, []);
      assert.equal(dialogs.filter(d => d.type === 'confirm').length, 1);
      if (failure || mode) {
        assert.deepEqual(dialogs.filter(d => d.type === 'alert').map(d => d.message), ['Error: ' + expectedMessage]);
        assert.deepEqual(state.closed, []);
        assert.equal(state.eventType, eventType);
        assert.equal(state.notes, 'Keep these notes');
        assert.equal(state.enteredBy, 'Test user');
        if (eventType === 'Remote Carbs Entry') assert.equal(state.carbs, '10');
        if (eventType === 'Remote Bolus Entry') assert.equal(state.bolus, '1');
      } else {
        assert.deepEqual(dialogs.filter(d => d.type === 'alert'), []);
        assert.deepEqual(state.closed, ['#treatmentDrawer']);
      }
    });
  }

  for (const [eventType, reason] of [
    ['Temporary Override', 'Loop notification failed: LOOP_APNS_KEY not set.'],
    ['Temporary Override Cancel', 'Loop notification failed: Could not find deviceToken in loopSettings.'],
    ['Remote Carbs Entry', 'Loop remote carbs failed. Incorrect carbs entry: '],
    ['Remote Bolus Entry', 'APNs delivery failed: InvalidProviderToken']
  ]) {
    it('shows the actionable failure and preserves the form for ' + eventType, async function () {
      const message = require('../../lib/api2/loop-notification-errors')(reason);
      await checkLoopSubmission(eventType, {status: 500, responseText: message}, message);
    });
  }
  for (const eventType of ['Temporary Override', 'Temporary Override Cancel', 'Remote Carbs Entry', 'Remote Bolus Entry']) {
    it('keeps an empty error response from being treated as success for ' + eventType, async function () {
      await checkLoopSubmission(eventType, {status: 500, responseText: ''}, emptyFailureMessage);
    });
  }
  for (const responseText of [undefined, {}, '   \n  ']) {
    it('shows a fallback for an unusable error body: ' + JSON.stringify(responseText), async function () {
      await checkLoopSubmission('Remote Carbs Entry', {status: 502, responseText}, emptyFailureMessage, typeof responseText === 'string' ? undefined : 'malformed');
    });
  }
  it('explains uncertain delivery after a connection failure and preserves the bolus form', async function () {
    await checkLoopSubmission('Remote Bolus Entry', undefined, connectionFailureMessage, 'connection');
  });
  it('explains uncertain delivery after a timeout and preserves the carbs form', async function () {
    await checkLoopSubmission('Remote Carbs Entry', undefined, connectionFailureMessage, 'timeout');
  });
  for (const status of [401, 403]) {
    for (const responseText of ['', JSON.stringify({status, message: 'Unauthorized'})]) {
      it('explains HTTP ' + status + ' authorization failures with body ' + JSON.stringify(responseText), async function () {
        await checkLoopSubmission('Temporary Override', {status, responseText}, authorizationFailureMessage);
      });
    }
  }
  it('closes the form after a successful Loop remote command without an error alert', async function () {
    await checkLoopSubmission('Temporary Override Cancel');
  });
});
