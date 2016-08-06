
'use strict';

require('should');


describe('ddata', function ( ) {
  // var cage = require('../lib/plugins/cannulaage')();
  var sandbox = require('../lib/sandbox')();
  var env = require('../env')();
  var ctx = {};
  ctx.ddata = require('../lib/data/ddata')();
  it('should be a module', function (done) {
    var libddata = require('../lib/data/ddata');
    // should.be.Function(libddata);
    var ddata = libddata( );
    // should.be.ok(ddata);
    // ({}).should.exist( );
    ddata = ctx.ddata.clone( );
    // ddata.should.be.ok( );
    done( );
  });
  it('has #clone( )', function (done) {
    var ddata = ctx.ddata.clone( );
    // ({}).should.be.ok( );
    // ddata.should.be.ok( );
    done( );
  });
});

describe('some garbage', function ( ) {
  var cage = require('../lib/plugins/cannulaage')();
  var sandbox = require('../lib/sandbox')();
  var env = require('../env')();
  var ctx = {};
  ctx.ddata = require('../lib/data/ddata')();
  ctx.notifications = require('../lib/notifications')(env, ctx);

  function prepareSandbox ( ) {
    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    sbx.offerProperty('iob', function () {
      return {iob: 0};
    });
    return sbx;
  }
  it('should should work', function (done) {
    var foo = {bar: true };
    // foo.should.exist( );
    // foo.should.be.ok( );
    done( );
  });
});

