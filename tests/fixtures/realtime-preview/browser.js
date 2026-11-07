'use strict';
// Explicit joined-campaign browser driver, outside tier/corpus test inventory.
// Controlled actual page/assets, actual API/RT roles, no io.connect patch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withPage } = require('../../browser/fixture');
module.exports = async function browserConsumer (input) {
  assert.equal(input.env.NS_RT_JOINED_BROWSER, '1');
  const hooks = require('../../browser/hooks');
  const planned = JSON.parse(fs.readFileSync(input.env.NS_RT_JOINED_CONFIG, 'utf8'));
  hooks.validateFixtureHosts(planned.browserResolverHosts);
  await hooks.launchNamedFixtureBrowser(planned.browserResolverHosts); let roles;
  try {
    roles = await require('./roles').start(input);
    assert(roles.config.uiFixture, 'explicit controlled UI fixture required; API alone does not serve UI');
    const config = roles.config, origin = 'http://' + config.browserHost + ':' + roles.ingress.port;
    assert(config.browserResolverHosts.includes(config.browserHost), 'root named alias admission must select this actual browser origin');
    const token = input.env[config.browserCredentialEnv]; assert(token);
    const { Client } = require('pg'), admin = new Client({ connectionString: input.env.NS_TEST_POSTGRES_ADMIN_URI });
    assert.match(config.entriesNamespace, /^[a-z][a-z0-9_]{0,62}$/); assert.equal(roles.owned.entriesNamespace, config.entriesNamespace);
    assert.equal(roles.owned.tenant, config.tenant);
    try {
      await admin.connect();
      await withPage(origin, async ({ page }) => {
        await page.goto(origin + '/?token=' + encodeURIComponent(token));
        await page.waitForFunction(mgdl => window.Nightscout?.client?.socket?.connected &&
          window.Nightscout.client.alarmSocket?.connected && window.Nightscout.client.ddata?.sgvs?.some(row => row.mgdl === mgdl), config.syntheticMgdl, { timeout: config.timeoutMs });
        const initial = await page.evaluate(() => ({ main: new URL(window.Nightscout.client.socket.io.uri).origin,
          alarm: new URL(window.Nightscout.client.alarmSocket.io.uri).origin, count: window.Nightscout.client.ddata.sgvs.length }));
        assert(initial.main.startsWith(origin) && initial.alarm.startsWith(origin), 'BROWSER_SAME_ORIGIN unchanged sockets must not use a separate RT port');
        await admin.query('DELETE FROM "' + config.entriesNamespace + '".entries WHERE tenant_id=$1', [config.tenant]);
        await page.waitForFunction(() => window.Nightscout.client.ddata.sgvs.length === 0, null, { timeout: config.timeoutMs });
        await page.evaluate(() => {
          window.__rtObservedAlarmEvents = [];
          for (const event of ['urgent_alarm', 'alarm', 'announcement']) window.Nightscout.client.alarmSocket.on(event, value => window.__rtObservedAlarmEvents.push({ event, value }));
        });
        const notification = { plugin: { name: 'treatmentnotify', pluginType: 'notification' }, level: 2, isAnnouncement: true, group: 'Announcement', title: 'Synthetic urgent announcement', message: 'Synthetic current-role fixture' };
        const accepted = require('../../../lib/server/realtime/alarm-transport').createAdapter({ socketPath: config.alarmSocketPath,
          maxBytes: config.maxMessageBytes, timeoutMs: config.timeoutMs }).send;
        await new Promise((resolve, reject) => accepted({ tenant: config.tenant, id: require('node:crypto').randomUUID(), attempt: 1,
          notification, receipts: [] }, (error, result) => { if (error) reject(error); else { assert.deepEqual(result, { accepted: true, receipt: null, clearedRequestIds: [] }); resolve(); } }));
        await page.waitForFunction(() => window.__rtObservedAlarmEvents.some(row => row.event === 'urgent_alarm'), null, { timeout: config.timeoutMs });
        await page.waitForFunction(() => !!document.querySelector('.container.alarming.urgent'), null, { timeout: config.timeoutMs });
        const result = await page.evaluate(() => ({ urgentUi: !!document.querySelector('.container.alarming.urgent'), sgvs: window.Nightscout.client.ddata.sgvs, events: window.__rtObservedAlarmEvents }));
        assert.equal(result.urgentUi, true); assert.deepEqual(result.sgvs, []); assert.equal(result.events.some(row => row.event === 'announcement'), false);
        fs.writeFileSync(path.join(input.captureDir, 'actual-browser-consumer.json'), JSON.stringify({ classification: 'controlled fixture UI, unchanged client, actual API/RT', origin, resolverHosts: config.browserResolverHosts, redirectRefusals: roles.ingress.redirectRefusals, initial, result }) + '\n');
      }, {fixtureHosts: config.browserResolverHosts});
    } finally { await admin.end(); }
  } catch (error) {
    // Browser navigation errors can contain the unchanged client's token URL.
    // Preserve the error kind/code while withholding inherited credentials.
    const secrets = Object.values(input.env).filter(value => typeof value === 'string' && value.length > 5);
    const scrub = value => secrets.reduce((text, secret) => text.split(secret).join('[private-env]').split(encodeURIComponent(secret)).join('[private-env]'), String(value));
    if (error && typeof error.message === 'string') error.message = scrub(error.message);
    if (error && typeof error.stack === 'string') error.stack = scrub(error.stack);
    throw error;
  } finally {
    try { if (roles) await roles.close(); } finally { await hooks.mochaHooks.afterAll(); }
  }
};
