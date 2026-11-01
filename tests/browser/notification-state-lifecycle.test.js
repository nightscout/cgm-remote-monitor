'use strict';
const assert = require('node:assert/strict');
const {withPage} = require('./fixture');
const {createPageFixture, hash} = require('../fixtures/page-startup/server');

describe('Notification state in the production browser bundle', function () {
  let io, origin;
  before(async function () { ({io, origin} = await createPageFixture()); });
  after(async function () { if (io) await new Promise(resolve => io.close(resolve)); });

  it('preserves active acknowledgements and retires queued and late work over two lifecycles', async function () {
    for (let cycle = 0; cycle < 2; cycle++) {
      await withPage(origin, async ({page}) => {
        await page.addInitScript(hash => localStorage.setItem('apisecrethash', hash), hash);
        await page.goto(origin);
        await page.waitForFunction(() => window.Nightscout?.client?.latestSGV?.mgdl === 123);
        try {
          const result = await page.evaluate(() => {
            const ctx = window.Nightscout.client.ctx;
            const service = ctx.notifications;
            const notify = {level: ctx.levels.WARN, group: 'owned-browser-fixture',
              title: 'Fixture', message: 'Fixture', plugin: {name: 'fixture'}};
            const events = [];
            const capture = event => events.push(event);
            ctx.bus.on('notification', capture);
            try {
              service.requestNotify(notify);
              service.requestSnooze({...notify, lengthMills: 600000});
              const queued = service.findHighestAlarm(notify.group) === notify;
              service.ack(ctx.levels.WARN, notify.group, 600000, true);
              const activeClear = events.length === 1 && events[0].clear === true;
              ctx.bus.teardown();
              ctx.bus.teardown();
              service.requestNotify(notify);
              service.requestSnooze({...notify, lengthMills: 600000});
              service.ack(ctx.levels.URGENT, 'owned-late-fixture', 600000, true);
              service.process();
              return {queued, activeClear, empty: service.findHighestAlarm(notify.group) === undefined,
                noSnooze: service.snoozedBy(notify) === false, eventCount: events.length};
            } finally { ctx.bus.removeListener('notification', capture); }
          });
          assert.deepEqual(result, {queued: true, activeClear: true, empty: true, noSnooze: true, eventCount: 1});
        } finally {
          await page.evaluate(() => {
            window.Nightscout.client.socket.disconnect();
            window.Nightscout.client.alarmSocket.disconnect();
          });
        }
      });
    }
  });
});
