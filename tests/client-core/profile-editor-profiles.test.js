'use strict';
require('should');

var profiles = require('../../lib/client-core/profile-editor/profiles');
var buildDefaultProfile = require('../../lib/client-core/profile-editor/default-profile');

function seedRecord () {
  return {
    defaultProfile: 'Default',
    store: { 'Default': buildDefaultProfile() }
  };
}

describe('client-core: profile-editor / profiles CRUD', function () {

  describe('uniqueName', function () {
    it('returns the base when free', function () {
      profiles.uniqueName({}, 'foo').should.equal('foo');
    });
    it('appends 1s until free', function () {
      profiles.uniqueName({ foo: 1, foo1: 1 }, 'foo').should.equal('foo11');
    });
  });

  describe('addProfile', function () {
    it('adds with the supplied baseName', function () {
      var rec = seedRecord();
      var res = profiles.addProfile(rec, buildDefaultProfile(), 'Weekday');
      res.currentProfile.should.equal('Weekday');
      rec.store.should.have.property('Weekday');
    });

    it('falls back to "New profile" and disambiguates collisions', function () {
      var rec = seedRecord();
      profiles.addProfile(rec, buildDefaultProfile());
      profiles.addProfile(rec, buildDefaultProfile());
      rec.store.should.have.property('New profile');
      rec.store.should.have.property('New profile1');
    });

    it('clones defaults so future mutations do not leak', function () {
      var rec = seedRecord();
      var defs = buildDefaultProfile();
      var res = profiles.addProfile(rec, defs, 'X');
      rec.store.X.should.not.equal(defs);
      rec.store.X.dia = 99;
      defs.dia.should.equal(3);
    });
  });

  describe('getFirstAvailableProfile', function () {
    it('returns null when only the current profile exists', function () {
      var rec = seedRecord();
      (profiles.getFirstAvailableProfile(rec, 'Default') === null).should.be.true();
    });
    it('returns first sibling key', function () {
      var rec = seedRecord();
      profiles.addProfile(rec, buildDefaultProfile(), 'A');
      profiles.getFirstAvailableProfile(rec, 'Default').should.equal('A');
    });
  });

  describe('removeProfile', function () {
    it('refuses when no other profile exists', function () {
      var rec = seedRecord();
      var res = profiles.removeProfile(rec, 'Default');
      res.removed.should.be.false();
      rec.store.should.have.property('Default');
    });
    it('deletes and switches to the first available', function () {
      var rec = seedRecord();
      profiles.addProfile(rec, buildDefaultProfile(), 'A');
      var res = profiles.removeProfile(rec, 'Default');
      res.removed.should.be.true();
      res.currentProfile.should.equal('A');
      rec.store.should.not.have.property('Default');
    });
  });

  describe('cloneProfile', function () {
    it('appends "(copy)" suffix and disambiguates', function () {
      var rec = seedRecord();
      profiles.cloneProfile(rec, 'Default');
      rec.store.should.have.property('Default (copy)');
      profiles.cloneProfile(rec, 'Default');
      rec.store.should.have.property('Default (copy)1');
    });
    it('deep-clones the source profile', function () {
      var rec = seedRecord();
      var res = profiles.cloneProfile(rec, 'Default');
      rec.store[res.currentProfile].should.not.equal(rec.store.Default);
      rec.store[res.currentProfile].dia = 99;
      rec.store.Default.dia.should.equal(3);
    });
  });

  describe('renameProfile', function () {
    it('is a no-op when names match', function () {
      var rec = seedRecord();
      var res = profiles.renameProfile(rec, 'Default', 'Default');
      res.renamed.should.be.false();
    });
    it('renames and disambiguates collisions', function () {
      var rec = seedRecord();
      profiles.addProfile(rec, buildDefaultProfile(), 'A');
      var res = profiles.renameProfile(rec, 'Default', 'A');
      res.renamed.should.be.true();
      res.currentProfile.should.equal('A1');
      rec.store.should.not.have.property('Default');
    });
  });
});
