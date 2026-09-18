'use strict';

const assert = require('node:assert/strict');
const {withPage} = require('./fixture');
const {createPageFixture, hash} = require('../fixtures/page-startup/server');
const fixture = require('../fixtures/timezone-2026c.json');

describe('Updated timezone rules in the production browser bundle', function () {
  let io, origin;
  before(async function () { ({io, origin} = await createPageFixture()); });
  after(async function () { if (io) await new Promise(resolve => io.close(resolve)); });
  // Historical 1953 corrections are server-only: browser data starts in 2015.
  for (const group of fixture.groups.filter(group => group.browser)) {
    for (const zone of group.zones) {
      it('formats transition boundaries and subsequent dates for ' + zone, async function () {
        await withPage(origin, async ({page}) => {
          await page.addInitScript(hash => localStorage.setItem('apisecrethash', hash), hash);
          await page.goto(origin);
          await page.waitForFunction(() => window.Nightscout?.client?.latestSGV?.mgdl === 123);
          try {
            for (let cycle = 0; cycle < 2; cycle++) {
              const actual = await page.evaluate(({zone, cases}) => cases.map(([iso]) => {
                const date = window.moment.utc(iso).tz(zone);
                return [date.format('YYYY-MM-DD HH:mm:ss'), date.utcOffset(), date.valueOf()];
              }), {zone, cases: group.cases});
              assert.deepEqual(actual, group.cases.map(([iso, label, offset]) => [label, offset, Date.parse(iso)]));
            }
          } finally {
            await page.evaluate(() => {
              window.Nightscout.client.socket.disconnect();
              window.Nightscout.client.alarmSocket.disconnect();
            });
          }
        });
      });
    }
  }
});
