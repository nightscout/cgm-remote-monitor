'use strict';

require('should');

var treatmentTime = require('../lib/client/treatmenttime');

var OLD = Date.parse('2026-01-02T10:00:00.000Z');
var NEW = new Date('2026-01-02T11:30:00.000Z');

// What the page holds for a Care Portal Meal Bolus once it has been loaded and
// drawn: the stored fields plus the ones Nightscout derived at the old time.
function pageTreatment (extra) {
  return Object.assign({
    _id: '65a000000000000000000001'
    , eventType: 'Meal Bolus'
    , created_at: new Date(OLD).toISOString()
    , carbs: 25
    , insulin: 2.5
    , enteredBy: 'synthetic'
    , notes: 'lunch'
    , mills: OLD
    , date: new Date(OLD)
    , mgdl: 110
    , scaled: 110
  }, extra);
}

describe('treatmenttime: moving a treatment from the chart', function () {

  describe('splitRecord (Move carbs / Move insulin)', function () {

    it('writes the new time only, with nothing the page derived at the old time', function () {
      var copy = treatmentTime.splitRecord(pageTreatment(), 'insulin', NEW);
      copy.created_at.should.equal(NEW.toISOString());
      ['mills', 'date', 'mgdl', 'scaled', 'endmills', 'cuttedby', 'cutting'].forEach(function (f) {
        copy.should.not.have.property(f);
      });
    });

    it('drops the identity and the half that stays behind, keeps the stored fields', function () {
      var copy = treatmentTime.splitRecord(pageTreatment({ NSCLIENT_ID: 7 }), 'insulin', NEW);
      copy.should.not.have.property('_id');
      copy.should.not.have.property('NSCLIENT_ID');
      copy.should.not.have.property('insulin');
      copy.carbs.should.equal(25);
      copy.eventType.should.equal('Meal Bolus');
      copy.enteredBy.should.equal('synthetic');
      copy.notes.should.equal('lunch');
    });

    it('drops the time-derived fields a duration record carries', function () {
      var copy = treatmentTime.splitRecord(pageTreatment({ duration: 30, endmills: OLD + 1800000,
        cuttedby: 'A', cutting: 'B' }), 'carbs', NEW);
      copy.duration.should.equal(30);
      copy.should.not.have.property('endmills');
      copy.should.not.have.property('cuttedby');
      copy.should.not.have.property('cutting');
    });

    it('moves a stored date (API v3 epoch ms) to the new time instead of dropping it', function () {
      var copy = treatmentTime.splitRecord(pageTreatment({ date: OLD }), 'insulin', NEW);
      copy.date.should.equal(NEW.getTime());
    });

    it('moves a stored ISO date left by an earlier split to the new time, as a number', function () {
      var copy = treatmentTime.splitRecord(pageTreatment({ date: new Date(OLD).toISOString() }), 'carbs', NEW);
      copy.date.should.equal(NEW.getTime());
    });

    it('does not modify the page object', function () {
      var t = pageTreatment();
      treatmentTime.splitRecord(t, 'insulin', NEW);
      t.mills.should.equal(OLD);
      t.insulin.should.equal(2.5);
      (t.date instanceof Date).should.equal(true);
    });
  });

  describe('timeFields (plain Move, and the half a split leaves behind)', function () {

    it('a plain Move sets created_at and clears a stored mills, endmills, mgdl and scaled', function () {
      var f = treatmentTime.timeFields(pageTreatment(), NEW);
      f.set.should.eql({ created_at: NEW.toISOString() });
      f.unset.should.eql({ mills: 1, endmills: 1, mgdl: 1, scaled: 1 });
    });

    it('a plain Move does not add a date to a record that had none', function () {
      treatmentTime.timeFields(pageTreatment(), NEW).set.should.not.have.property('date');
    });

    it('a plain Move carries a stored date (number or ISO string) to the new time', function () {
      treatmentTime.timeFields(pageTreatment({ date: OLD }), NEW).set.date.should.equal(NEW.getTime());
      treatmentTime.timeFields(pageTreatment({ date: new Date(OLD).toISOString() }), NEW)
        .set.date.should.equal(NEW.getTime());
    });

    it('the record a split leaves behind keeps its time, and a stored date that disagrees is corrected', function () {
      var t = pageTreatment({ created_at: NEW.toISOString(), date: new Date(OLD).toISOString() });
      var f = treatmentTime.timeFields(t);
      f.set.should.eql({ date: NEW.getTime() });
      f.unset.should.eql({ mills: 1, endmills: 1, mgdl: 1, scaled: 1 });
    });

    it('the record a split leaves behind is not rewritten when its stored date agrees', function () {
      var t = pageTreatment({ date: OLD });
      treatmentTime.timeFields(t).set.should.eql({});
    });
  });

  describe('alignEditedRecord (report editor PUT)', function () {

    it('drops mills, endmills, mgdl and scaled, and moves a stored date to the edited time', function () {
      var r = { _id: 'x', created_at: new Date(OLD).toISOString(), mills: OLD, endmills: OLD + 1,
        date: new Date(OLD).toISOString(), mgdl: 110, scaled: 110, carbs: 25 };
      treatmentTime.alignEditedRecord(r, NEW.toISOString());
      ['mills', 'endmills', 'mgdl', 'scaled'].forEach(function (f) { r.should.not.have.property(f); });
      r.date.should.equal(NEW.getTime());
      r.carbs.should.equal(25);
    });

    it('does not add a date to a record that had none', function () {
      var r = { mills: OLD, carbs: 25 };
      treatmentTime.alignEditedRecord(r, NEW.toISOString());
      r.should.not.have.property('date');
    });
  });
});
