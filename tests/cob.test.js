'use strict';

require('should');
var sandbox = require('../lib/sandbox')();

describe('COB', function ( ) {
  var cob = require('../lib/plugins/cob')();
  
  var profileData = {
    sens: 95
    , carbratio: 18
    , carbs_hr: 30
  };

  var profile = require('../lib/profilefunctions')([profileData]);

  it('should calculate COB, multiple treatments', function() {

    var treatments = [
      {
        'carbs': '100',
        'mills': new Date('2015-05-29T02:03:48.827Z').getTime()
      },
      {
        'carbs': '10',
        'mills': new Date('2015-05-29T03:45:10.670Z').getTime()
      }
    ];

    var sbx = sandbox.clientInit({}, Date.now(), {}, {treatments: treatments, profile: profile});

    var after100 = cob.cobTotal(sbx, new Date('2015-05-29T02:03:49.827Z').getTime());
    var before10 = cob.cobTotal(sbx, new Date('2015-05-29T03:45:10.670Z').getTime());
    var after10 = cob.cobTotal(sbx, new Date('2015-05-29T03:45:11.670Z').getTime());

    after100.cob.should.equal(100);
    Math.round(before10.cob).should.equal(59);
    Math.round(after10.cob).should.equal(69); //WTF == 128
  });

  it('should calculate COB, single treatment', function() {

    var treatments = [
      {
        'carbs': '8',
        'mills': new Date('2015-05-29T04:40:40.174Z').getTime()
      }
    ];

    var rightAfterCorrection = new Date('2015-05-29T04:41:40.174Z').getTime();
    var later1 = new Date('2015-05-29T05:04:40.174Z').getTime();
    var later2 = new Date('2015-05-29T05:20:00.174Z').getTime();
    var later3 = new Date('2015-05-29T05:50:00.174Z').getTime();
    var later4 = new Date('2015-05-29T06:50:00.174Z').getTime();

    var sbx = sandbox.clientInit({}, Date.now(), {}, {treatments: treatments, profile: profile});

    var result1 = cob.cobTotal(sbx, rightAfterCorrection);
    var result2 = cob.cobTotal(sbx, later1);
    var result3 = cob.cobTotal(sbx, later2);
    var result4 = cob.cobTotal(sbx, later3);
    var result5 = cob.cobTotal(sbx, later4);

    result1.cob.should.equal(8);
    result2.cob.should.equal(6);
    result3.cob.should.equal(0);
    result4.cob.should.equal(0);
    result5.cob.should.equal(0);
  });

  it('set a pill to the current COB', function (done) {

    var clientSettings = {};

    var data = {
      treatments: [{
        carbs: '8'
        , 'mills': Date.now() - 60000 //1m ago
      }]
      , profile: profile
    };

    var pluginBase = {
      updatePillText: function mockedUpdatePillText (plugin, options) {
        options.value.should.equal('8g');
        done();
      }
    };

    var sandbox = require('../lib/sandbox')();
    var sbx = sandbox.clientInit(clientSettings, Date.now(), pluginBase, data);
    cob.setProperties(sbx);
    cob.updateVisualisation(sbx);

  });


});
