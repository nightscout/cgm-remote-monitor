var should = require('should');

describe('sandbox', function ( ) {
  var sandbox = require('../lib/sandbox')();

  var now = Date.now();

  it('init on client', function (done) {
    var ctx = {
      settings: {
        units: 'mg/dl'
        , thresholds:{
          bgHigh: 260
          , bgTargetTop: 180
          , bgTargetBottom: 80
          , bgLow: 55
        }
      }
      , pluginBase: {}
    };
    
    ctx.language = require('../lib/language')();

    var data = {sgvs: [{mgdl: 100, mills: now}]};

    var sbx = sandbox.clientInit(ctx, Date.now(), data);

    sbx.pluginBase.should.equal(ctx.pluginBase);
    sbx.data.should.equal(data);
    sbx.lastSGVMgdl().should.equal(100);

    done();
  });

  function createServerSandbox() {
    var env = require('../lib/server/env')();
    var ctx = {};
    ctx.ddata = require('../lib/data/ddata')();
    ctx.notifications = require('../lib/notifications')(env, ctx);
    ctx.language = require('../lib/language')();

    return sandbox.serverInit(env, ctx);
  }

  it('init on server', function (done) {
    var sbx = createServerSandbox();
    sbx.data.sgvs = [{mgdl: 100, mills: now}];

    should.exist(sbx.notifications.requestNotify);
    should.not.exist(sbx.notifications.process);
    should.not.exist(sbx.notifications.ack);
    sbx.lastSGVMgdl().should.equal(100);

    done();
  });

  it('display 39 as LOW and 401 as HIGH', function () {
    var sbx = createServerSandbox();

    sbx.displayBg({mgdl: 39}).should.equal('LOW');
    sbx.displayBg({mgdl: '39'}).should.equal('LOW');
    sbx.displayBg({mgdl: 401}).should.equal('HIGH');
    sbx.displayBg({mgdl: '401'}).should.equal('HIGH');
  });

  it('build BG Now line using properties', function ( ) {
    var sbx = createServerSandbox();
    sbx.data.sgvs = [{mgdl: 99, mills: now}];
    sbx.properties = { delta: {display: '+5' }, direction: {value: 'FortyFiveUp', label: '↗', entity: '&#8599;'} };

    sbx.buildBGNowLine().should.equal('BG Now: 99 +5 ↗ mg/dl');

  });

  it('build default message using properties', function ( ) {
    var sbx = createServerSandbox();
    sbx.data.sgvs = [{mgdl: 99, mills: now}];
    sbx.properties = {
      delta: {display: '+5' }
      , direction: {value: 'FortyFiveUp', label: '↗', entity: '&#8599;'}
      , rawbg: {displayLine: 'Raw BG: 100 mg/dl'}
      , iob: {displayLine: 'IOB: 1.25U'}
      , cob: {displayLine: 'COB: 15g'}
    };

    sbx.buildDefaultMessage().should.equal('BG Now: 99 +5 ↗ mg/dl\nRaw BG: 100 mg/dl\nIOB: 1.25U\nCOB: 15g');

  });

});
