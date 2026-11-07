'use strict';
// Controlled real-browser fixture UI + unchanged production page/client assets;
// actual separate API/RT roles. API product remains headless. No io.connect patch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { optInSuite } = require('../support/opt-in');
const { withPage } = require('./fixture');
optInSuite(process.env.NS_RT_JOINED_BROWSER === '1' && process.env.NS_RT_JOINED_NATIVE === '1',
  'root-owned joined realtime browser phase')('actual realtime unchanged browser consumer', function () {
  this.timeout(60000); let roles;
  before(async function () {
    roles = await require('../fixtures/realtime-preview/roles').start({ sourceDir: path.resolve(__dirname, '../..'),
      captureDir: process.env.NS_RT_NATIVE_CAPTURE, phaseId: process.env.NS_RT_NATIVE_PHASE, env: process.env });
    assert(roles.config.uiFixture, 'explicit controlled UI fixture required; API alone does not serve UI');
  });
  after(async function () { if (roles) await roles.close(); });
  it('uses same-origin unchanged main/alarm connections, repairs SGV absence and preserves alarm event', async function () {
    const config = roles.config, origin = 'http://127.0.0.1:' + roles.ingress.port;
    assert.equal(config.browserHost, '127.0.0.1', 'root alias admission must select this unchanged browser origin');
    const token = process.env[config.browserCredentialEnv]; assert(token);
    const { Client } = require('pg'), admin = new Client({ connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI });
    assert.match(config.entriesNamespace, /^[a-z][a-z0-9_]{0,62}$/); assert.equal(roles.owned.entriesNamespace, config.entriesNamespace);
    assert.equal(roles.owned.tenant, config.tenant);
    try {
      await admin.connect();
      await withPage(origin, async ({ page }) => {
        await page.goto(origin + '/?token=' + encodeURIComponent(token));
        await page.waitForFunction(mgdl => window.Nightscout?.client?.socket?.connected &&
          window.Nightscout.client.alarmSocket?.connected && window.Nightscout.client.ddata?.sgvs?.some(row => row.mgdl === mgdl), config.syntheticMgdl, { timeout: config.timeoutMs });
        const initial = await page.evaluate(() => ({ main: window.Nightscout.client.socket.io.uri,
          alarm: window.Nightscout.client.alarmSocket.io.uri, count: window.Nightscout.client.ddata.sgvs.length }));
        assert(initial.main.startsWith(origin) && initial.alarm.startsWith(origin), 'BROWSER_SAME_ORIGIN unchanged sockets must not use a separate RT port');
        await admin.query('DELETE FROM "' + config.entriesNamespace + '".entries WHERE tenant_id=$1', [config.tenant]);
        await page.waitForFunction(() => window.Nightscout.client.ddata.sgvs.length === 0, null, { timeout: config.timeoutMs });
        await page.evaluate(() => {
          window.__rtObservedAlarmEvents = [];
          for (const event of ['urgent_alarm', 'alarm', 'announcement']) window.Nightscout.client.alarmSocket.on(event, value => window.__rtObservedAlarmEvents.push({ event, value }));
        });
        const notification = { plugin: { name: 'treatmentnotify', pluginType: 'notification' }, level: 2, isAnnouncement: true, group: 'Announcement', title: 'Synthetic urgent announcement', message: 'Synthetic current-role fixture' };
        const accepted = require('../../lib/server/realtime/alarm-transport').createAdapter({ socketPath: config.alarmSocketPath,
          maxBytes: config.maxMessageBytes, timeoutMs: config.timeoutMs }).send;
        await new Promise((resolve, reject) => accepted({ tenant: config.tenant, id: require('node:crypto').randomUUID(), attempt: 1,
          notification, receipts: [] }, (error, result) => { if (error) reject(error); else { assert.deepEqual(result, { accepted: true, receipt: null, clearedRequestIds: [] }); resolve(); } }));
        await page.waitForFunction(() => window.__rtObservedAlarmEvents.some(row => row.event === 'urgent_alarm'), null, { timeout: config.timeoutMs });
        await page.waitForFunction(() => !!document.querySelector('.container.alarming.urgent'), null, { timeout: config.timeoutMs });
        const result = await page.evaluate(() => ({ urgentUi: !!document.querySelector('.container.alarming.urgent'), sgvs: window.Nightscout.client.ddata.sgvs, events: window.__rtObservedAlarmEvents }));
        assert.equal(result.urgentUi, true); assert.deepEqual(result.sgvs, []); assert.equal(result.events.some(row => row.event === 'announcement'), false);
        fs.writeFileSync(path.join(process.env.NS_RT_NATIVE_CAPTURE, 'actual-browser-consumer.json'), JSON.stringify({ classification: 'controlled fixture UI, unchanged client, actual API/RT', initial, result }) + '\n');
      });
    } finally { await admin.end(); }
  });
});
