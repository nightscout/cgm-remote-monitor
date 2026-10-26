'use strict';

require('should');

describe('write-validation rules', function () {
  const wv = require('../lib/server/write-validation');

  function tt (fields) {
    return Object.assign({ eventType: 'Temporary Target', duration: 60 }, fields);
  }

  function rules (doc) {
    return wv.checkTreatment(doc).map(p => p.rule + ':' + p.field);
  }

  it('reads the mode, and anything unknown as off', () => {
    wv.parseMode('reject').should.equal('reject');
    wv.parseMode(' LOG ').should.equal('log');
    wv.parseMode('true').should.equal('off');
    wv.parseMode(undefined).should.equal('off');
    wv.mode({}).should.equal('off');
    wv.mode({ writeValidation: 'bogus' }).should.equal('off');
  });

  it('knows the units spellings clients send', () => {
    wv.canonicalUnits('mmol').should.equal('mmol');
    wv.canonicalUnits('mmol/L').should.equal('mmol');
    wv.canonicalUnits('mg/dL').should.equal('mg/dl');
    wv.canonicalUnits('mgdl').should.equal('mg/dl');
    (wv.canonicalUnits('mmol/mol') === null).should.be.true();
    (wv.canonicalUnits(18) === null).should.be.true();
  });

  it('accepts ordinary targets in either unit, and no units', () => {
    rules(tt({ targetBottom: 80, targetTop: 140, units: 'mg/dl' })).should.eql([]);
    rules(tt({ targetBottom: 4.4, targetTop: 8, units: 'mmol' })).should.eql([]);
    rules(tt({ targetBottom: 99, targetTop: 99 })).should.eql([]);
  });

  it('flags a value implausible for its declared units', () => {
    rules(tt({ targetBottom: 99.09, targetTop: 99.09, units: 'mmol' }))
      .should.eql(['tt-units-plausible:targetBottom', 'tt-units-plausible:targetTop']);
    rules(tt({ targetBottom: 5.5, targetTop: 6, units: 'mg/dl' }))
      .should.eql(['tt-units-plausible:targetBottom', 'tt-units-plausible:targetTop']);
    rules(tt({ targetBottom: 30, targetTop: 30, units: 'mmol' })).should.eql([]);
    rules(tt({ targetBottom: 20, targetTop: 20, units: 'mg/dl' })).should.eql([]);
  });

  it('flags order, non-finite and missing targets', () => {
    rules(tt({ targetBottom: 140, targetTop: 90 })).should.eql(['tt-order:targetBottom']);
    rules(tt({ targetBottom: Infinity, targetTop: 90 })).should.eql(['tt-target:targetBottom']);
    rules(tt({ targetBottom: NaN, targetTop: 90 })).should.eql(['tt-target:targetBottom']);
    rules(tt({ targetTop: 90 })).should.eql(['tt-target:targetBottom']);
    rules(tt({ targetBottom: -1, targetTop: 90 })).should.eql(['tt-target:targetBottom']);
  });

  it('treats duration 0 as a cancel with no targets, and checks durations', () => {
    rules(tt({ duration: 0 })).should.eql([]);
    rules(tt({ duration: undefined, durationInMilliseconds: 0 })).should.eql([]);
    rules(tt({ duration: -5, targetBottom: 80, targetTop: 90 })).should.eql(['tt-duration:duration']);
    rules(tt({ duration: 0, units: 'banana' })).should.eql(['tt-units:units']);
  });

  it('checks only Temporary Targets', () => {
    rules({ eventType: 'Note', units: 'banana', targetBottom: 9, targetTop: 1 }).should.eql([]);
    rules({ eventType: 'Temporary Target Cancel' }).should.eql([]);
  });

  it('normalises a known units spelling and leaves an unknown one', () => {
    const a = tt({ units: 'mmol/L' });
    wv.normalizeUnits(a);
    a.units.should.equal('mmol');
    const b = tt({ units: 'banana' });
    wv.normalizeUnits(b);
    b.units.should.equal('banana');
  });

  it('logs rules and fields, never values', () => {
    const doc = tt({ identifier: 'abc', targetBottom: 99.09, targetTop: 99.09, units: 'mmol' });
    const line = wv.logLine('API v3', doc, wv.checkTreatment(doc));
    line.should.match(/tt-units-plausible:targetTop/);
    line.should.not.match(/99\.09/);
  });

  it('never words a refusal as a message AndroidAPS string-matches', () => {
    const docs = [
      tt({ targetBottom: 99.09, targetTop: 99.09, units: 'mmol' }),
      tt({ targetBottom: 5, targetTop: 6, units: 'mg/dl' }),
      tt({ targetBottom: 140, targetTop: 90 }),
      tt({ targetBottom: Infinity, targetTop: NaN, units: 'banana' }),
      tt({ duration: -1, durationInMilliseconds: 'x' }),
      tt({})
    ];
    const rulesSeen = new Set();
    docs.forEach(doc => {
      const problems = wv.checkTreatment(doc);
      problems.length.should.be.above(0);
      problems.forEach(p => rulesSeen.add(p.rule));
      const texts = [wv.describe(problems), wv.ValidationError(problems).message,
        JSON.stringify(wv.refusal(doc, problems).refused)];
      texts.forEach(text => {
        text.should.not.match(/Bad or missing utcOffset/i);
        text.should.not.match(/cannot be modified/i);
      });
    });
    // every rule's message was covered
    Array.from(rulesSeen).sort().should.eql(['tt-duration', 'tt-order', 'tt-target', 'tt-units', 'tt-units-plausible']);
  });
});
