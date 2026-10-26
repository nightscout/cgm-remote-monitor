'use strict';

const assert = require('node:assert/strict');
const renderer = require('../lib/api3/shared/renderer');
const cases = require('./fixtures/api3/csv-contract.json');

function renderCsv(data) {
  return new Promise(resolve => renderer.render({
    format(handlers) { handlers.csv(); },
    send: resolve
  }, data));
}

describe('API3 CSV export byte contracts', function () {
  // Goldens captured from csv-stringify 5.6.5 through the production renderer.
  // Check bytes independently of the parser used by the HTTP renderer tests.
  for (const fixture of cases) {
    it('preserves ' + fixture.name + ' through repeated exports', async function () {
      const data = structuredClone(fixture.data);
      for (let cycle = 0; cycle < 2; cycle++) {
        assert.equal(await renderCsv(data), fixture.csv);
        assert.deepEqual(data, fixture.data, 'Export must not mutate stored data');
      }
    });
  }

  it('preserves Date casting and undefined cells', async function () {
    const data = {when: new Date('2020-01-02T03:04:05Z'), absent: undefined};
    for (let cycle = 0; cycle < 2; cycle++) {
      assert.equal(await renderCsv(data), 'when,absent\n1577934245000,\n');
      assert.ok(data.when instanceof Date);
    }
  });

  it('preserves row order across larger repeated exports', async function () {
    const rows = Array.from({length: 4096}, (_, index) => ({date: 1700000000000 + index * 300000, sgv: 80 + index % 80}));
    const expected = 'date,sgv\n' + rows.map(row => row.date + ',' + row.sgv + '\n').join('');
    for (let cycle = 0; cycle < 2; cycle++) assert.equal(await renderCsv(rows), expected);
  });
});
