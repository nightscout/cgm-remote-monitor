'use strict';

const assert = require('node:assert/strict');
const qs = require('qs');
const {withPage} = require('./fixture');
const {createPageFixture, hash} = require('../fixtures/page-startup/server');

describe('Food editor widget interactions', function () {
  for (const reload of [false, true]) {
  it('drags foods, edits portions and sends reordered updates twice ' + (reload ? 'with reloads' : 'without reloads'), async function () {
    const foodId = '000000000000000000000001';
    const pickIds = ['000000000000000000000002', '000000000000000000000003'];
    const food = {_id: foodId, type: 'food', name: 'Owned oats', carbs: 10, portion: 25, unit: 'g', category: 'Owned', subcategory: '', gi: 2};
    const picks = ['a', 'b'].map((name, position) => ({_id: pickIds[position], type: 'quickpick', name: 'Meal ' + name, position, foods: [], hidden: 'false', hideafteruse: 'true'}));
    const records = [food, ...picks];
    const fixture = await createPageFixture({apiData: {'/api/v1/food.json': records}});
    const writes = [];
    try {
      await withPage(fixture.origin, async ({page}) => {
        await page.setViewportSize({width: 1800, height: 1200});
        await page.addInitScript(value => localStorage.setItem('apisecrethash', value), hash);
        // Capture the actual serialized outgoing update. This verifies the UI/API
        // boundary, not MongoDB persistence or server-side authorization.
        await page.route(fixture.origin + '/api/v1/food/', async route => {
          if (route.request().method() !== 'PUT') return route.fallback();
          writes.push(new URLSearchParams(route.request().postData()));
          const saved = qs.parse(route.request().postData());
          const index = records.findIndex(record => record._id === saved._id);
          assert.ok(index >= 0, 'Update an existing owned quick pick');
          records[index] = saved;
          await route.fulfill({status: 200, contentType: 'application/json', body: '{}'});
        });
        try {
          await page.goto(fixture.origin + '/food');
          await page.waitForFunction(() => document.querySelector('#fe_status').textContent === 'Database loaded');
          await page.waitForFunction(() => window.Nightscout.client.hashauth.isAuthenticated());
          for (let cycle = 0; cycle < 2; cycle++) {
            const selected = pickIds[cycle];
            const source = page.locator('.draggablefood');
            const target = page.locator('.sortablequickpick[_id="' + selected + '"]');
            await source.dragTo(target);
            await target.locator('.fe_foodinsideqp').waitFor({state: 'visible'});
            assert.equal(await target.locator('.fe_foodinsideqp').count(), 1, 'One food per drop');
            const portions = target.locator('.fe_qpportions');
            await portions.fill(String(cycle + 2));
            await portions.press('Tab');
            await page.waitForFunction(({selected, total}) => document.querySelector('.sortablequickpick[_id="' + selected + '"] legend').textContent.includes('Carbs: ' + total + ' g'), {selected, total: (cycle + 2) * 10});

            const first = page.locator('.sortablequickpick').first();
            const second = page.locator('.sortablequickpick').nth(1);
            const from = await first.boundingBox(), to = await second.boundingBox();
            await page.mouse.move(from.x + 10, from.y + from.height - 8); await page.mouse.down();
            await page.mouse.move(to.x + 10, to.y + to.height - 3, {steps: 20}); await page.mouse.up();
            const order = cycle === 0 ? [pickIds[1], pickIds[0]] : pickIds;
            await page.waitForFunction(order => Array.from(document.querySelectorAll('.sortablequickpick')).map(node => node.getAttribute('_id')).join(',') === order.join(','), order);
            await page.locator('#fe_quickpick_save').click();
            await page.waitForFunction(() => window.$.active === 0);
            assert.equal(writes.length, (cycle + 1) * 2, 'Exactly one update per quick pick');
            const batch = writes.slice(cycle * 2).sort((a, b) => Number(a.get('position')) - Number(b.get('position')));
            assert.deepEqual(batch.map(record => record.get('_id')), order);
            assert.deepEqual(batch.map(record => record.get('position')), ['0', '1']);
            const saved = batch.find(record => record.get('_id') === selected);
            assert.equal(saved.get('carbs'), String((cycle + 2) * 10));
            assert.equal(saved.get('foods[0][_id]'), foodId);
            assert.equal(saved.get('foods[0][portions]'), String(cycle + 2));
            for (const record of batch) {
              if (record.has('foods[0][portions]')) {
                assert.equal(Number(record.get('carbs')), Number(record.get('foods[0][carbs]')) * Number(record.get('foods[0][portions]')), 'Each quick pick retains internally consistent portions and totals');
              }
            }
            assert.equal(await source.count(), 1, 'Dragging preserves the original food row');
            if (reload) {
            await page.reload();
            await page.waitForFunction(() => document.querySelector('#fe_status').textContent === 'Database loaded');
            assert.deepEqual(await page.locator('.sortablequickpick').evaluateAll(nodes => nodes.map(node => node.getAttribute('_id'))), order);
            assert.equal(await target.locator('.fe_qpportions').inputValue(), String(cycle + 2));
            assert.ok((await target.locator('legend').textContent()).includes('Carbs: ' + ((cycle + 2) * 10) + ' g'));
            }

          }
        } finally {
          await page.evaluate(() => {
            const client = window.Nightscout && window.Nightscout.client;
            if (client && client.socket) client.socket.disconnect();
            if (client && client.alarmSocket) client.alarmSocket.disconnect();
          });
        }
      });
    } finally {await new Promise(resolve => fixture.io.close(resolve));}
  });
  }
});
