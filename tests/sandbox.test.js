var should = require('should');

describe('sandbox', function ( ) {
  var sandbox = require('../lib/sandbox')();

  var now = Date.now();

  it('init on client', function (done) {
    var app = {
      thresholds:{
        bg_high: 260
        , bg_target_top: 180
        , bg_target_bottom: 80
        , bg_low: 55
      }
    };

    var clientSettings = {
      units: 'mg/dl'
    };

    var pluginBase = {};
    var data = {sgvs: [{y: 100, x: now}]};

    var sbx = sandbox.clientInit(app, clientSettings, Date.now(), pluginBase, data);

    sbx.pluginBase.should.equal(pluginBase);
    sbx.data.should.equal(data);
    sbx.lastSGV().should.equal(100);

    done();
  });

  function createServerSandbox() {
    var env = require('../env')();
    var ctx = {};
    ctx.data = require('../lib/data')(env, ctx);
    ctx.notifications = require('../lib/notifications')(env, ctx);

    return sandbox.serverInit(env, ctx);
  }

  it('init on server', function (done) {
    var sbx = createServerSandbox();
    sbx.data.sgvs = [{y: 100, x: now}];

    should.exist(sbx.notifications.requestNotify);
    should.not.exist(sbx.notifications.process);
    should.not.exist(sbx.notifications.ack);
    sbx.lastSGV().should.equal(100);

    done();
  });

  it('display 39 as LOW and 401 as HIGH', function () {
    var sbx = createServerSandbox();

    sbx.displayBg(39).should.equal('LOW');
    sbx.displayBg('39').should.equal('LOW');
    sbx.displayBg(401).should.equal('HIGH');
    sbx.displayBg('401').should.equal('HIGH');
  });

  it('build BG Now line using properties', function ( ) {
    var sbx = createServerSandbox();
    sbx.data.sgvs = [{y: 99, x: now}];
    sbx.properties = { delta: {display: '+5' }, direction: {value: 'FortyFiveUp', label: '↗', entity: '&#8599;'} };

    sbx.buildBGNowLine().should.equal('BG Now: 99 +5 ↗ mg/dl');

  });

  it('build default message using properties', function ( ) {
    var sbx = createServerSandbox();
    sbx.data.sgvs = [{y: 99, x: now}];
    sbx.properties = {
      delta: {display: '+5' }
      , direction: {value: 'FortyFiveUp', label: '↗', entity: '&#8599;'}
      , rawbg: {displayLine: 'Raw BG: 100 mg/dl'}
      , iob: {displayLine: 'IOB: 1.25U'}
      , cob: {displayLine: 'COB: 15g'}
    };

    sbx.buildDefaultMessage().should.equal('BG Now: 99 +5 ↗ mg/dl\nRaw BG: 100 mg/dl\nIOB: 1.25U\nCOB: 15g');

  });

  //FIXME: field mismatch between server and client :(, remove this test when we get that cleaned up
  it('Use the x or date fields to find an entries time in mills', function () {
    var sbx = createServerSandbox();

    sbx.entryMills({x: now}).should.equal(now);
    sbx.entryMills({date: now}).should.equal(now);
  });


});
