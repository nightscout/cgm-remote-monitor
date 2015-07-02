var should = require('should');

describe('sandbox', function ( ) {
  var sandbox = require('../lib/sandbox')();

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
    var data = {sgvs: [{sgv: 100}]};

    var sbx = sandbox.clientInit(app, clientSettings, Date.now(), pluginBase, data);

    sbx.pluginBase.should.equal(pluginBase);
    sbx.data.should.equal(data);
    sbx.data.lastSGV().should.equal(100);

    done();
  });

  it('init on server', function (done) {
    var env = require('../env')();
    var ctx = {};
    ctx.data = require('../lib/data')(env, ctx);
    ctx.data.sgvs = [{sgv: 100}];
    ctx.notifications = require('../lib/notifications')(env, ctx);

    var sbx = sandbox.serverInit(env, ctx);

    should.exist(sbx.notifications.requestNotify);
    should.not.exist(sbx.notifications.process);
    should.not.exist(sbx.notifications.ack);
    sbx.data.lastSGV().should.equal(100);

    done();
  });

  it('display 39 as LOW and 401 as HIGH', function () {
    var env = require('../env')();
    var ctx = {};
    ctx.data = require('../lib/data')(env, ctx);
    ctx.notifications = require('../lib/notifications')(env, ctx);

    var sbx = sandbox.serverInit(env, ctx);

    sbx.displayBg(39).should.equal('LOW');
    sbx.displayBg('39').should.equal('LOW');
    sbx.displayBg(401).should.equal('HIGH');
    sbx.displayBg('401').should.equal('HIGH');
  });

});
