'use strict';

const assert = require('node:assert/strict');
const {withPage} = require('./fixture');
const {createPageFixture, hash} = require('../fixtures/page-startup/server');

// A drawer is sized from the window when it opens: the full window on a small
// screen, otherwise 350px wide and the window height less 45px. A resize that
// leaves it open must give it the size it would get if opened at the new size.
// A chart width change closes the open drawer (chart.js), so a width change
// may also close it; it must never leave a stale size behind.
describe('Drawer size after a window resize (UI-DRAWER-RESIZE)', function () {
  const now = Date.parse('2026-01-01T14:05:06.250Z');
  let fixture;
  before(async function () {
    fixture = await createPageFixture({payload: {
      sgvs: [{mgdl: 123, mills: now, direction: 'Flat', type: 'sgv'}],
      treatments: [], profiles: [], devicestatus: []
    }});
  });
  after(async function () {if (fixture) await new Promise(resolve => fixture.io.close(resolve));});

  async function load(page, theme, viewport) {
    await page.setViewportSize(viewport);
    await page.clock.setFixedTime(new Date(now));
    await page.addInitScript(({hash, theme}) => {
      localStorage.setItem('apisecrethash', hash);
      localStorage.setItem('theme', theme);
    }, {hash, theme});
    await page.goto(fixture.origin);
    await page.waitForFunction(() => document.querySelector('.currentBG')?.textContent.trim() === '123');
  }

  function measure(page, id) {
    return page.locator(id).evaluate(element => {
      const rect = element.getBoundingClientRect();
      return {open: getComputedStyle(element).display !== 'none',
        width: element.style.width, height: element.style.height,
        rendered: [Math.round(rect.width), Math.round(rect.height)]};
    });
  }

  // What openDrawer sets at this window size (jQuery reads the viewport size).
  function expected({width, height}) {
    return width < 500 || (height < 500 && width < 800)
      ? {width: width + 'px', height: height + 'px'}
      : {width: '350px', height: (height - 45) + 'px'};
  }

  async function toggle(page, id) {
    await page.evaluate(id => window.Nightscout.client.browserUtils.toggleDrawer(id), id);
    await page.waitForFunction(id => !document.querySelector(id).getAnimations().length, id);
  }

  // Wait for the page's own resize event: the viewport can change a frame
  // before the event that the drawer and chart handlers listen to.
  async function resize(page, viewport) {
    await page.evaluate(() => {
      window.drawerResized = new Promise(resolve => window.addEventListener('resize', resolve, {once: true}));
    });
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.drawerResized.then(() =>
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
  }

  async function freshOpen(page, id) {
    if ((await measure(page, id)).open) await toggle(page, id);
    await toggle(page, id);
    return measure(page, id);
  }

  const heightChanges = [
    ['grows taller', {width: 1440, height: 600}, {width: 1440, height: 900}],
    ['grows from a short full-window drawer', {width: 700, height: 420}, {width: 700, height: 900}],
    ['shrinks to a short full-window drawer', {width: 700, height: 900}, {width: 700, height: 420}]
  ];
  const widthChanges = [
    ['grows from 390px to 1440px', {width: 390, height: 844}, {width: 1440, height: 900}],
    ['shrinks from 1440px to 390px', {width: 1440, height: 900}, {width: 390, height: 844}]
  ];

  for (const theme of ['default', 'modern']) {
    for (const id of ['#drawer', '#adminNotifiesDrawer']) {
      for (const [label, from, to] of heightChanges) {
        it(theme + ' ' + id + ' keeps the size of a fresh open when the window ' + label, async function () {
          await withPage(fixture.origin, async ({page}) => {
            await load(page, theme, from);
            if (id === '#drawer') await page.locator('#drawerToggle').click();
            else await toggle(page, id);
            await page.waitForFunction(id => !document.querySelector(id).getAnimations().length, id);
            assert.deepEqual(await measure(page, id), {...await measure(page, id), open: true, ...expected(from)});
            await resize(page, to);
            const resized = await measure(page, id);
            assert.equal(resized.open, true, 'A height-only resize leaves the drawer open');
            assert.deepEqual({width: resized.width, height: resized.height}, expected(to));
            assert.deepEqual(resized, await freshOpen(page, id));
          }, {timezoneId: 'UTC'});
        });
      }
      for (const [label, from, to] of widthChanges) {
        it(theme + ' ' + id + ' is closed or sized for the new window when the window ' + label, async function () {
          await withPage(fixture.origin, async ({page}) => {
            await load(page, theme, from);
            await toggle(page, id);
            assert.deepEqual(await measure(page, id), {...await measure(page, id), open: true, ...expected(from)});
            await resize(page, to);
            await page.waitForFunction(id => !document.querySelector(id).getAnimations().length, id);
            const resized = await measure(page, id);
            if (resized.open) {
              assert.deepEqual({width: resized.width, height: resized.height}, expected(to));
              assert.deepEqual(resized, await freshOpen(page, id));
            }
          }, {timezoneId: 'UTC'});
        });
      }
    }
  }
});
