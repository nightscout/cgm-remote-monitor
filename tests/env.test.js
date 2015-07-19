'use strict';

require('should');

describe('env', function ( ) {

  it('set thresholds', function () {
    process.env.BG_HIGH = 200;
    process.env.BG_TARGET_TOP = 170;
    process.env.BG_TARGET_BOTTOM = 70;
    process.env.BG_LOW = 60;

    var env = require('../env')();

    env.thresholds.bg_high.should.equal(200);
    env.thresholds.bg_target_top.should.equal(170);
    env.thresholds.bg_target_bottom.should.equal(70);
    env.thresholds.bg_low.should.equal(60);

    env.alarm_types.should.equal('simple');


    delete process.env.BG_HIGH;
    delete process.env.BG_TARGET_TOP;
    delete process.env.BG_TARGET_BOTTOM;
    delete process.env.BG_LOW;
  });

  it('handle screwed up thresholds in a way that will display something that looks wrong', function () {
    process.env.BG_HIGH = 89;
    process.env.BG_TARGET_TOP = 90;
    process.env.BG_TARGET_BOTTOM = 95;
    process.env.BG_LOW = 96;

    var env = require('../env')();

    env.thresholds.bg_high.should.equal(91);
    env.thresholds.bg_target_top.should.equal(90);
    env.thresholds.bg_target_bottom.should.equal(89);
    env.thresholds.bg_low.should.equal(88);

    env.alarm_types.should.equal('simple');


    delete process.env.BG_HIGH;
    delete process.env.BG_TARGET_TOP;
    delete process.env.BG_TARGET_BOTTOM;
    delete process.env.BG_LOW;
  });

  it('show the right plugins', function () {
    process.env.SHOW_PLUGINS = 'iob';
    process.env.ENABLE = 'iob cob';

    var env = require('../env')();
    env.defaults.showPlugins.should.containEql('iob');
    env.defaults.showPlugins.should.containEql('delta');
    env.defaults.showPlugins.should.containEql('direction');
    env.defaults.showPlugins.should.containEql('upbat');
    env.defaults.showPlugins.should.not.containEql('cob');

    delete process.env.SHOW_PLUGINS;
    delete process.env.ENABLE;
  });

  it('get extended settings', function () {
    process.env.ENABLE = 'scaryplugin';
    process.env.SCARYPLUGIN_DO_THING = 'yes';

    var env = require('../env')();
    env.isEnabled('scaryplugin').should.equal(true);

    //Note the camelCase
    env.extendedSettings.scaryplugin.doThing.should.equal('yes');

    delete process.env.ENABLE;
    delete process.env.SCARYPLUGIN_DO_THING;
  });

});
