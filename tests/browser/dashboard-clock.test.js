'use strict';

const assert = require('node:assert/strict');
const {withPage} = require('./fixture');
const {createPageFixture, hash} = require('../fixtures/page-startup/server');

describe('Dashboard seconds clock', function () {
  const now = Date.parse('2026-01-01T14:05:06.250Z');
  let fixture;
  before(async function () {
    fixture = await createPageFixture({payload: {
      sgvs: [{mgdl: 123, mills: now, direction: 'Flat', type: 'sgv'}],
      treatments: [], profiles: [], devicestatus: []
    }});
  });
  after(async function () {if (fixture) await new Promise(resolve => fixture.io.close(resolve));});

  for (const theme of ['default', 'modern']) {
    for (const timeFormat of [12, 24]) {
      it('ticks only the clock and persists the setting in ' + theme + ' at ' + timeFormat + ' hours', async function () {
        await withPage(fixture.origin, async ({page}) => {
          await page.clock.setFixedTime(new Date(now));
          await page.addInitScript(({hash, theme, timeFormat}) => {
            localStorage.setItem('apisecrethash', hash);
            if (!localStorage.getItem('clock-seeded')) {
              localStorage.setItem('clock-seeded', 'true');
              localStorage.setItem('theme', theme);
              localStorage.setItem('timeFormat', String(timeFormat));
              localStorage.setItem('showSeconds', 'true');
            }
          }, {hash, theme, timeFormat});
          async function ready() {
            await page.waitForFunction(() => document.querySelector('.currentBG')?.textContent.trim() === '123');
            // Modern layout settles its initial ResizeObserver work after the
            // first data render. Do not count that as a seconds-ticker update.
            await page.evaluate(() => document.fonts.ready.then(() => new Promise(resolve =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)))));
          }
          await page.goto(fixture.origin);
          await ready();
          assert.equal(await page.locator('html').evaluate(html => html.classList.contains('modern-ui')), theme === 'modern');
          assert.equal(await page.locator('#currentTime').textContent(), timeFormat === 24 ? '14:05:06' : '2:05:06 pm');
          await page.evaluate(() => {
            const client = window.Nightscout.client;
            const original = client.plugins.setProperties;
            window.clockMaintenance = 0;
            client.plugins.setProperties = function (...args) {
              window.clockMaintenance++;
              return original.apply(this, args);
            };
          });
          for (const second of [7, 8]) {
            await page.clock.setFixedTime(new Date(now + (second - 6) * 1000));
            await page.waitForFunction(expected => document.querySelector('#currentTime').textContent === expected,
              timeFormat === 24 ? '14:05:0' + second : '2:05:0' + second + ' pm');
          }
          assert.equal(await page.evaluate(() => window.clockMaintenance), 0,
            'Seconds ticks must not recompute chart/plugin state');

          await page.locator('#drawerToggle').click();
          assert.equal(await page.locator('#show-seconds-browser').isChecked(), true);
          // Exercise the native checkbox's keyboard interaction in both drawers.
          await page.locator('#show-seconds-browser').focus();
          await page.locator('#show-seconds-browser').press('Space');
          assert.equal(await page.locator('#show-seconds-browser').isChecked(), false);
          await Promise.all([page.waitForEvent('load'), page.locator('#save').click()]);
          await ready();
          assert.equal(await page.evaluate(() => window.Nightscout.client.settings.showSeconds), false);
          assert.doesNotMatch(await page.locator('#currentTime').textContent(), /\d+:\d+:\d+/);
          await page.locator('#drawerToggle').click();
          assert.equal(await page.locator('#show-seconds-browser').isChecked(), false);
          await page.locator('#show-seconds-browser').focus();
          await page.locator('#show-seconds-browser').press('Space');
          assert.equal(await page.locator('#show-seconds-browser').isChecked(), true);
          await Promise.all([page.waitForEvent('load'), page.locator('#save').click()]);
          await ready();
          assert.equal(await page.evaluate(() => window.Nightscout.client.settings.showSeconds), true);
          assert.equal(await page.locator('#currentTime').textContent(), timeFormat === 24 ? '14:05:08' : '2:05:08 pm');
        }, {timezoneId: 'UTC'});
      });
    }
  }
});
