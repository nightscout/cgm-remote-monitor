'use strict';

/**
 * bootevent-readable-warning.test.js
 *
 * The boot-time "Nightscout readable by world" admin notice.
 *
 * AUTH_DEFAULT_ROLES is a role LIST. Other settings append to it - the
 * deprecated TREATMENTS_AUTH=off adds ' careportal' - so the notice cannot
 * be decided by comparing the whole setting string to 'readable'. These
 * tests pin the decision to role membership, and check it against the
 * strings that lib/server/env actually produces.
 */

const should = require('should');

const bootevent = require('../lib/server/bootevent');
const worldReadableNotify = bootevent.worldReadableNotify;
const config = require('../lib/server/env');

const SECURITY_DOC = 'https://nightscout.github.io/nightscout/security/#how-to-turn-off-unauthorized-access';

describe('boot-time world-readable admin notice', function () {

  describe('which notice a role list earns', function () {

    function notifyFor (authDefaultRoles) {
      return worldReadableNotify({ authDefaultRoles: authDefaultRoles });
    }

    it('warns on the shipped default, readable', function () {
      const notify = notifyFor('readable');
      should.exist(notify);
      notify.title.should.equal('Nightscout readable by world');
      notify.persistent.should.equal(true);
      notify.message.should.containEql('readable by anyone who knows the web page URL');
      notify.message.should.containEql(SECURITY_DOC);
    });

    it('warns on readable careportal, which is strictly wider', function () {
      const notify = notifyFor('readable careportal');
      should.exist(notify);
      notify.persistent.should.equal(true);
      notify.message.should.containEql(SECURITY_DOC);
    });

    it('says anonymous treatment entry is open when careportal is present', function () {
      const notify = notifyFor('readable careportal');
      notify.title.should.not.equal('Nightscout readable by world');
      notify.message.should.containEql('treatment entries');
      notify.message.should.containEql('without a password');
    });

    it('does not claim treatment entry is open on plain readable', function () {
      notifyFor('readable').message.should.not.containEql('treatment entries');
    });

    it('stays quiet on denied', function () {
      (notifyFor('denied') === null).should.equal(true);
    });

    it('stays quiet on denied careportal', function () {
      // careportal without readable does not in fact accept anonymous
      // treatment entry: the treatments API applies a read check for the
      // whole router before the per-route create check.
      (notifyFor('denied careportal') === null).should.equal(true);
    });

    it('stays quiet on careportal alone', function () {
      (notifyFor('careportal') === null).should.equal(true);
    });

    it('stays quiet on status-only', function () {
      (notifyFor('status-only') === null).should.equal(true);
    });

    it('stays quiet on an empty, unset or absent setting', function () {
      (notifyFor('') === null).should.equal(true);
      (notifyFor(undefined) === null).should.equal(true);
      (notifyFor(null) === null).should.equal(true);
      (worldReadableNotify({}) === null).should.equal(true);
      (worldReadableNotify(undefined) === null).should.equal(true);
    });

    it('stays quiet on the leading-separator empty element', function () {
      // AUTH_DEFAULT_ROLES unset plus TREATMENTS_AUTH=off appends to "",
      // which parses to ['', 'careportal']. The empty element must not be
      // mistaken for a role.
      (notifyFor(' careportal') === null).should.equal(true);
    });

    it('reads comma and colon separated lists too', function () {
      notifyFor('readable,careportal').message.should.containEql('treatment entries');
      notifyFor('readable:careportal').message.should.containEql('treatment entries');
      notifyFor('admin:readable').title.should.equal('Nightscout readable by world');
    });

    it('is not confused by a role name that merely contains readable', function () {
      (notifyFor('notreadable') === null).should.equal(true);
    });

    it('tolerates a repeated append', function () {
      notifyFor('readable careportal careportal').message.should.containEql('treatment entries');
    });
  });

  describe('against the role list lib/server/env actually resolves', function () {

    // lib/server/env writes into a shared settings object and only
    // overwrites a setting when its environment variable is present, so
    // reset the list to the shipped default before resolving each case.
    function resolve (vars) {
      delete process.env.AUTH_DEFAULT_ROLES;
      delete process.env.TREATMENTS_AUTH;
      process.env.AUTH_DEFAULT_ROLES = 'readable';
      config();
      delete process.env.AUTH_DEFAULT_ROLES;

      Object.keys(vars).forEach(function set (key) { process.env[key] = vars[key]; });
      const resolved = config().settings.authDefaultRoles;
      Object.keys(vars).forEach(function unset (key) { delete process.env[key]; });
      return resolved;
    }

    after(function restore () {
      delete process.env.TREATMENTS_AUTH;
      process.env.AUTH_DEFAULT_ROLES = 'readable';
      config();
      delete process.env.AUTH_DEFAULT_ROLES;
    });

    it('warns on the default configuration', function () {
      const roles = resolve({});
      roles.should.equal('readable');
      should.exist(worldReadableNotify({ authDefaultRoles: roles }));
    });

    it('warns when TREATMENTS_AUTH=off widens the default', function () {
      const roles = resolve({ TREATMENTS_AUTH: 'off' });
      roles.should.equal('readable careportal');
      const notify = worldReadableNotify({ authDefaultRoles: roles });
      should.exist(notify);
      notify.message.should.containEql('treatment entries');
    });

    it('stays quiet when the operator has closed access', function () {
      const roles = resolve({ AUTH_DEFAULT_ROLES: 'denied' });
      roles.should.equal('denied');
      (worldReadableNotify({ authDefaultRoles: roles }) === null).should.equal(true);
    });

    it('stays quiet on a closed site even with TREATMENTS_AUTH=off', function () {
      const roles = resolve({ AUTH_DEFAULT_ROLES: 'denied', TREATMENTS_AUTH: 'off' });
      roles.should.equal('denied careportal');
      (worldReadableNotify({ authDefaultRoles: roles }) === null).should.equal(true);
    });
  });

  describe('the notice as adminnotifies receives it', function () {

    function adminnotifiesFor (authDefaultRoles) {
      const ctx = {
        bus: { on: function on () {} }
        , settings: { adminNotifiesEnabled: true }
      };
      const adminnotifies = require('../lib/adminnotifies')(ctx);
      const notify = worldReadableNotify({ authDefaultRoles: authDefaultRoles });
      if (notify) { adminnotifies.addNotify(notify); }
      return adminnotifies;
    }

    it('reaches the admin notify list for readable careportal', function () {
      const notifies = adminnotifiesFor('readable careportal').getNotifies();
      notifies.length.should.equal(1);
      notifies[0].count.should.equal(1);
    });

    it('survives the twelve hour cleanup, being persistent', function () {
      const adminnotifies = adminnotifiesFor('readable careportal');
      adminnotifies.getNotifies()[0].lastRecorded = 0;
      adminnotifies.clean();
      adminnotifies.getNotifies().length.should.equal(1);
    });

    it('adds nothing for denied', function () {
      adminnotifiesFor('denied').getNotifies().length.should.equal(0);
    });
  });
});
