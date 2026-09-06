'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const path = require('node:path');
const createApp = require('../../lib/server/app');
const {withPage} = require('./fixture');
const registerApiDocs = require('../../lib/server/api-docs');

describe('Interactive API documentation', function () {
  let server, origin;
  const requests = [];
  before(async function () {
    const env = {name: 'owned-swagger', version: 'fixture', trustProxy: '127.0.0.1,::1',
      insecureUseHttp: true, secureHstsHeader: false, secureCsp: true,
      secureCspReportOnly: false, allowUnrestrictedFrameEmbedding: true,
      static_files: path.resolve(__dirname, '../../static'), settings: require('../../lib/settings')()};
    // Read the actual application's enforced policy without booting a database.
    const policyResponse = await request(createApp(env, {bootErrors: [{desc: 'fixture', err: 'fixture'}]})).get('/fixture-policy');
    const policy = policyResponse.headers['content-security-policy'];
    assert(policy && policy.includes("script-src 'self'"));
    const app = express();
    app.use((req, res, next) => {res.set('Content-Security-Policy', policy); next();});
    registerApiDocs(app);
    for (const version of ['v1', 'v3']) {
      app.get('/api/' + version + '/status', (req, res) => {
        requests.push({version, authorization: req.headers.authorization, secret: req.headers['api-secret']});
        if (req.headers.authorization !== 'Bearer fixture-token-' + version) return res.status(401).json({error: 'fixture authorization required'});
        res.json({fixture: version, status: 'ok'});
      });
    }
    server = await new Promise(resolve => {const listening = app.listen(0, '127.0.0.1', () => resolve(listening));});
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () {if (server) await new Promise(resolve => server.close(resolve));});

  for (const [route, version] of [['/api-docs/', 'v1'], ['/api3-docs/', 'v3']]) {
    it('renders and executes owned read-only requests from ' + route + ' twice', async function () {
      await withPage(origin, async ({page}) => {
        for (let cycle = 0; cycle < 2; cycle++) {
          await page.goto(origin + route);
          await page.waitForFunction(() => window.ui && window.ui.specSelectors.specJson().get('paths'));
          assert.equal(await page.evaluate(() => window.ui.specSelectors.specJson().getIn(['servers', 0, 'url'])), '/api/' + version);
          assert.equal(await page.evaluate(() => window.ui.authSelectors.authorized().size), 0);
          await page.getByRole('button', {name: 'Authorize', exact: true}).first().click();
          const auth = page.locator('.auth-container').filter({hasText: 'jwtoken'});
          await auth.locator('input').fill('fixture-token-' + version);
          await auth.getByRole('button', {name: 'Apply credentials', exact: true}).click();
          await auth.getByRole('button', {name: 'Close', exact: true}).click();
          const operation = page.locator('.opblock').filter({has: page.locator('.opblock-summary-path[data-path="/status"]')});
          assert.equal(await operation.count(), 1);
          await operation.locator('.opblock-summary-control').click();
          await operation.getByRole('button', {name: 'Try it out'}).click();
          const response = page.waitForResponse(response => response.url() === origin + '/api/' + version + '/status');
          await operation.getByRole('button', {name: 'Execute', exact: true}).click();
          assert.deepEqual(await (await response).json(), {fixture: version, status: 'ok'});
          await operation.locator('.responses-inner').getByText('"fixture"', {exact: false}).first().waitFor();
        }
      });
      const observed = requests.filter(request => request.version === version);
      assert.equal(observed.length, 2);
      assert(observed.every(request => request.authorization === 'Bearer fixture-token-' + version));
    });
  }
  it('keeps mobile authorization controls visible and keyboard-operable for both schemas', async function () {
    await withPage(origin, async ({page}) => {
      await page.setViewportSize({width: 390, height: 844});
      for (const route of ['/api-docs/', '/api3-docs/']) {
        await page.goto(origin + route);
        const open = page.getByRole('button', {name: 'Authorize', exact: true}).first();
        await open.focus();
        await page.keyboard.press('Enter');
        const auth = page.locator('.auth-container').filter({hasText: 'jwtoken'});
        await auth.locator('input').fill('fixture-mobile-token');
        const apply = auth.getByRole('button', {name: 'Apply credentials', exact: true});
        await apply.scrollIntoViewIfNeeded();
        const bounds = await apply.boundingBox();
        assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390);
        await apply.focus();
        await page.keyboard.press('Enter');
        const close = auth.getByRole('button', {name: 'Close', exact: true});
        await close.focus();
        await page.keyboard.press('Enter');
        await page.locator('.modal-ux').waitFor({state: 'hidden'});
        assert.equal(await page.evaluate(() => window.ui.authSelectors.authorized().getIn(['jwtoken', 'value'])), 'fixture-mobile-token');
      }
    });
  });

});
