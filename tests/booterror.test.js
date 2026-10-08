'use strict';

const request = require('supertest');

require('should');

// The boot error page lists every entry in ctx.bootErrors. Each line was built
// with Object.getOwnPropertyNames(obj.err), which throws for an entry whose err
// is missing or null, so the page meant to explain the failure became a
// TypeError instead.
describe('boot error page', function ( ) {

  function render (bootErrors, done) {
    const app = require('../lib/server/booterror')({ }, { bootErrors: bootErrors });
    request(app)
      .get('/')
      .expect(500)
      .end(done);
  }

  it('renders a string err (control)', function (done) {
    render([{ desc: 'Mandatory setting missing', err: 'API_SECRET setting is missing' }], function (err, res) {
      if (err) return done(err);
      res.text.should.containEql('<dt><b>Mandatory setting missing</b></dt><dd>API_SECRET setting is missing</dd>');
      done( );
    });
  });

  it('renders an Error err (control)', function (done) {
    render([{ desc: 'Unable to setup authorization', err: new Error('boom') }], function (err, res) {
      if (err) return done(err);
      res.text.should.containEql('<dt><b>Unable to setup authorization</b></dt>');
      res.text.should.containEql('boom');
      done( );
    });
  });

  it('renders the description of a boot error that has no err', function (done) {
    render([{ desc: 'CONNECT_COUNTRY_CODE is required' }], function (err, res) {
      if (err) return done(err);
      res.text.should.not.containEql('TypeError');
      res.text.should.containEql('Nightscout - Boot error');
      res.text.should.containEql('<dt><b>CONNECT_COUNTRY_CODE is required</b></dt>');
      done( );
    });
  });

  it('renders the description of a boot error whose err is null', function (done) {
    render([{ desc: 'Something failed', err: null }, { desc: 'Second', err: 'still shown' }], function (err, res) {
      if (err) return done(err);
      res.text.should.not.containEql('TypeError');
      res.text.should.containEql('<dt><b>Something failed</b></dt>');
      res.text.should.containEql('<dt><b>Second</b></dt><dd>still shown</dd>');
      done( );
    });
  });

});
