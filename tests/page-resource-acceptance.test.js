'use strict';

const assert = require('node:assert/strict');
const acceptance = require('../tools/page-resource-acceptance');
const startup = require('../docs/audits/page-startup-baseline.json');
const journey = require('../docs/audits/page-journey-baseline.json');

describe('Measured page resource acceptance', function () {
  it('accepts the complete captured comparison', function () {
    assert.equal(acceptance.startup(startup.rows, 7).pass, true);
    assert.equal(acceptance.journey(journey.rows, 7).pass, true);
  });
  it('does not treat a small probe as release evidence', function () {
    assert.equal(acceptance.startup(startup.rows.slice(0, 10), 1).assessed, false);
    assert.equal(acceptance.journey(journey.rows.slice(0, 2), 1).assessed, false);
  });
  it('rejects missing or duplicated measurement runs', function () {
    assert.equal(acceptance.startup(startup.rows.slice(1), 7).pass, false);
    const duplicated = structuredClone(journey.rows);
    duplicated.find(row => row.label === 'candidate' && row.run === 1).run = 0;
    assert.equal(acceptance.journey(duplicated, 7).pass, false);
  });
  it('rejects a half-second startup regression against the matched parent', function () {
    const slow = startup.rows.map(row => row.label === 'candidate' ? {...row, startupMs: row.startupMs + 500} : row);
    assert.equal(acceptance.startup(slow, 7).pass, false);
  });
  it('rejects excessive retained heap in even one sample', function () {
    const large = structuredClone(startup.rows);
    large.find(row => row.label === 'candidate' && row.entry === 'app').heap.usedSize = 50000000;
    assert.equal(acceptance.startup(large, 7).pass, false);
  });
  it('rejects omitted revisits and a bundle redownload during a cached visit', function () {
    const missing = structuredClone(journey.rows);
    missing[0].steps.pop();
    assert.equal(acceptance.journey(missing, 7).pass, false);
    const redownload = structuredClone(journey.rows);
    redownload.find(row => row.label === 'candidate').steps.find(step => step.phase === 'cachedVisit').bundleRequests.push({path: '/bundle/js/bundle.app.js'});
    assert.equal(acceptance.journey(redownload, 7).pass, false);
  });
  it('rejects excessive request count or transferred response bodies independently', function () {
    for (const [key, value] of [['nonPollingRequests', 300], ['totalResponseBodyBytes', 3000000]]) {
      const excessive = structuredClone(journey.rows);
      excessive.find(row => row.label === 'candidate')[key] = value;
      assert.equal(acceptance.journey(excessive, 7).pass, false);
    }
  });
});
