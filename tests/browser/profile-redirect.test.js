'use strict';

// BF-159: on a site with no profile, the main page (with the basal plugin)
// sends the viewer to the Profile Editor. A viewer who opened the page with
// ?token= used to arrive there without it, and the Profile Editor reads its
// token only from its own address.

const assert = require('node:assert/strict');
const {getBrowser} = require('./hooks');
const {createPageFixture, hash} = require('../fixtures/page-startup/server');

describe('main page redirect to the Profile Editor in a real browser', function () {
  let fixture;
  afterEach(async function () {if (fixture) await new Promise(resolve => fixture.io.close(resolve)); fixture = undefined;});

  async function redirectFrom(query) {
    fixture = await createPageFixture({enable: 'basal',
      payload: {sgvs: [{mgdl: 123, mills: Date.now(), direction: 'Flat', type: 'sgv'}], treatments: [], profiles: [], devicestatus: []}});
    const context = await getBrowser().newContext({serviceWorkers: 'block'});
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(10000);
      const dialogs = [];
      page.on('dialog', dialog => {dialogs.push(dialog.message()); dialog.accept().catch(() => {});});
      await page.addInitScript(hash => localStorage.setItem('apisecrethash', hash), hash);
      await page.goto(fixture.origin + '/' + query);
      await page.waitForURL(url => url.pathname === '/profile');
      return {url: new URL(page.url()), dialogs};
    } finally {await context.close();}
  }

  it('keeps the page token on the way to the Profile Editor', async function () {
    const {url, dialogs} = await redirectFrom('?token=viewer-1a2b3c%2Bx');
    assert.deepEqual(dialogs, ['Redirecting you to the Profile Editor to create a new profile.']);
    assert.equal(url.searchParams.get('token'), 'viewer-1a2b3c+x');
  });

  it('adds nothing when the page was opened without a token', async function () {
    const {url} = await redirectFrom('');
    assert.equal(url.search, '');
  });
});
