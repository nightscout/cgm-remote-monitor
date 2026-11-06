'use strict';

// BF-92: a server alarm that is not about glucose (pump, loop, OpenAPS, site
// or sensor age...) reaches the page over the alarm socket in its plugin's own
// group. A page with no glucose reading used to treat every server alarm as
// "disabled locally", so a pump alarm on a page showing --- was silent. Glucose
// alarms (default group) are judged by the reading, as before.
//
// A page without a current reading also cleared the alarm's state on every
// redraw while the looping
// sound played on, and the BG button opens the silence menu only while the
// page is alarming. Each case below therefore also delivers a data update and
// then silences the alarm from the page, the way a person would.

const assert = require('node:assert/strict');
const {getBrowser} = require('./hooks');
const {createPageFixture, hash} = require('../fixtures/page-startup/server');

describe('server alarms on the main page in a real browser', function () {
  let fixture;
  const noReading = {sgvs: [], treatments: [], profiles: [], devicestatus: []};
  const inRange = () => ({sgvs: [{mgdl: 123, mills: Date.now(), direction: 'Flat', type: 'sgv'}], treatments: [], profiles: [], devicestatus: []});
  afterEach(async function () {if (fixture) await new Promise(resolve => fixture.io.close(resolve)); fixture = undefined;});

  function pump(level) {
    return {level, group: 'Pump', plugin: {name: 'pump', label: 'Pump'}, key: 'pump_' + level, timestamp: Date.now(),
      title: level === 2 ? 'URGENT: Pump Reservoir Low' : 'Warning, Pump Reservoir Low', message: 'Pump Reservoir: 2.00U'};
  }
  function urgentLow() {
    return {level: 2, group: 'default', plugin: {name: 'simplealarms'}, eventName: 'low', timestamp: Date.now(),
      title: 'Urgent, LOW', message: 'BG Now: 44 mg/dl'};
  }

  async function withMainPage(payload, run) {
    fixture = await createPageFixture({payload});
    const context = await getBrowser().newContext({serviceWorkers: 'block'});
    const errors = [];
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      if (process.env.DEBUG_ALARMS) page.on('console', m => console.log('page:', m.text().slice(0, 300)));
      await page.addInitScript(hash => localStorage.setItem('apisecrethash', hash), hash);
      await page.goto(fixture.origin + '/');
      await page.waitForFunction(() => window.Nightscout && window.Nightscout.client.ddata && window.Nightscout.client.alarmSocket
        && window.Nightscout.client.alarmSocket.connected && window.$.active === 0);
      // The page subscribes on connect; wait until the server holds it.
      for (let i = 0; i < 50 && fixture.io.of('/alarm').sockets.size === 0; i++) await page.waitForTimeout(100);
      assert.equal(fixture.io.of('/alarm').sockets.size, 1);
      const state = () => page.evaluate(() => {
        const container = document.getElementById('container');
        return {alarming: container.classList.contains('alarming'), urgent: container.classList.contains('urgent'),
          warning: container.classList.contains('warning'), bg: document.querySelector('.currentBG').textContent.trim(),
          playing: document.querySelectorAll('audio.playing').length};
      });
      const received = () => page.evaluate(() => window.__alarmEvents || 0);
      await page.evaluate(() => {window.Nightscout.client.alarmSocket.onAny(() => {window.__alarmEvents = (window.__alarmEvents || 0) + 1;});});
      const send = async (event, notify) => {
        const before = await received();
        fixture.io.of('/alarm').emit(event, notify);
        await page.waitForFunction(n => (window.__alarmEvents || 0) > n, before);
      };
      // New data (a device status) reaches the page and the page redraws.
      const dataUpdate = async () => {
        await page.evaluate(() => {window.__updates = 0; window.Nightscout.client.socket.on('dataUpdate', () => {window.__updates++;});});
        fixture.io.of('/').emit('dataUpdate', {delta: true, lastUpdated: Date.now(), devicestatus: [{_id: 'ds1', mills: Date.now(), device: 'synthetic'}]});
        await page.waitForFunction(() => window.__updates > 0);
      };
      // Silence from the page: the BG button opens the silence menu.
      const silence = async () => {
        await page.locator('.bgButton').click();
        await page.locator('#silenceBtn a').first().click();
      };
      await run({page, state, send, dataUpdate, silence});
    } finally {await context.close();}
    assert.deepEqual(errors, [], 'Uncaught page errors');
  }

  it('presents an urgent pump alarm on a page with no reading, and not a glucose alarm', async function () {
    await withMainPage(noReading, async ({state, send, dataUpdate, silence}) => {
      assert.equal((await state()).bg, '---');
      await send('urgent_alarm', urgentLow());
      assert.equal((await state()).alarming, false, 'a glucose alarm is still judged by the reading');
      await send('urgent_alarm', pump(2));
      assert.deepEqual(await state(), {alarming: true, urgent: true, warning: false, bg: '---', playing: 1});
      await dataUpdate();
      assert.deepEqual(await state(), {alarming: true, urgent: true, warning: false, bg: '---', playing: 1});
      await silence();
      assert.deepEqual(await state(), {alarming: false, urgent: false, warning: false, bg: '---', playing: 0});
    });
  });

  it('presents a pump warning on a page with no reading', async function () {
    await withMainPage(noReading, async ({state, send}) => {
      await send('alarm', pump(1));
      assert.deepEqual(await state(), {alarming: true, urgent: false, warning: true, bg: '---', playing: 1});
    });
  });

  it('control: presents the same urgent pump alarm on a page with an in-range reading (unchanged)', async function () {
    await withMainPage(inRange(), async ({page, state, send, dataUpdate, silence}) => {
      await page.waitForFunction(() => document.querySelector('.currentBG').textContent.trim() === '123');
      await send('urgent_alarm', pump(2));
      await dataUpdate();
      assert.deepEqual(await state(), {alarming: true, urgent: true, warning: false, bg: '123', playing: 1});
      await silence();
      assert.equal((await state()).playing, 0);
    });
  });
});
