'use strict';

require('should');

const uniqSgv = require('../lib/report/uniqsgv');

const SEC = 1000;
const BASE = 1600000000000;

function at (/* seconds... */) {
  return Array.prototype.slice.call(arguments).map(function (s) {
    return { mills: BASE + (s * SEC), sgv: 100 };
  });
}

function seconds (entries) {
  return entries.map(function (d) { return (d.mills - BASE) / SEC; });
}

describe('report sgv de-duplication', () => {

  it('does not cascade: a dropped entry must not become the reference', () => {
    // 58s is dropped. If the reference moved onto it, 116s would be measured
    // against 58s (58s apart) and dropped too - although it is 116s away from
    // the last kept entry. This is the regression this filter exists for.
    seconds(uniqSgv(at(0, 58, 116))).should.eql([0, 116]);
  });

  it('keeps entries exactly one minute apart', () => {
    seconds(uniqSgv(at(0, 60, 120))).should.eql([0, 60, 120]);
  });

  it('drops a true duplicate but keeps the next valid entry', () => {
    seconds(uniqSgv(at(0, 0, 60))).should.eql([0, 60]);
  });

  it('leaves five-minute series untouched', () => {
    seconds(uniqSgv(at(0, 300, 600))).should.eql([0, 300, 600]);
  });

  it('reports every dropped entry to the callback', () => {
    const dropped = [];
    uniqSgv(at(0, 58, 116), function (d) { dropped.push((d.mills - BASE) / SEC); });
    dropped.should.eql([58]);
  });

  it('works without a callback', () => {
    seconds(uniqSgv(at(0, 58, 116))).should.eql([0, 116]);
  });

  it('handles an empty series', () => {
    uniqSgv([]).should.eql([]);
  });

  it('does not sort - callers pass sorted input', () => {
    // Documents the contract rather than adding behaviour: the report sorts
    // before calling, so the filter stays a single-purpose pass.
    seconds(uniqSgv(at(120, 0, 60))).should.eql([120]);
  });

});
