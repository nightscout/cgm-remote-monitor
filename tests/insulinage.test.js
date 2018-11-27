'use strict';

require('should');
var levels = require('../lib/levels');

describe('insulinage', function ( ) {
    var env = require('../env')();
    var ctx = {};
    ctx.ddata = require('../lib/data/ddata')();
    ctx.notifications = require('../lib/notifications')(env, ctx);
    ctx.language = require('../lib/language')();

    var iage = require('../lib/plugins/insulinage')(ctx);
    var sandbox = require('../lib/sandbox')();
    function prepareSandbox ( ) {
        var sbx = require('../lib/sandbox')().serverInit(env, ctx);
        sbx.offerProperty('iob', function () {
            return {iob: 0};
        });
        return sbx;
    }

    it('set a pill to the current insulin age', function (done) {

        var data = {
            insulinchangeTreatments: [
                {eventType: 'Insulin Change', notes: 'Foo', mills: Date.now() - 48 * 60 * 60000}
                , {eventType: 'Insulin Change', notes: 'Bar', mills: Date.now() - 24 * 60 * 60000}
            ]
        };

        var ctx = {
            settings: {}
            , pluginBase: {
                updatePillText: function mockedUpdatePillText(plugin, options) {
                    options.value.should.equal('1d0h');
                    options.info[1].value.should.equal('Bar');
                    done();
                }
            }
        };
       ctx.language = require('../lib/language')();

        var sbx = sandbox.clientInit(ctx, Date.now(), data);
        iage.setProperties(sbx);
        iage.updateVisualisation(sbx);

    });

    it('set a pill to the current insulin age', function (done) {

        var data = {
            insulinchangeTreatments: [
                {eventType: 'Insulin Change', notes: 'Foo', mills: Date.now() - 48 * 60 * 60000}
                , {eventType: 'Insulin Change', notes: '', mills: Date.now() - 59 * 60000}
            ]
        };

        var ctx = {
            settings: {}
            , pluginBase: {
                updatePillText: function mockedUpdatePillText(plugin, options) {
                    options.value.should.equal('0h');
                    options.info.length.should.equal(1);
                    done();
                }
            }
        };
       ctx.language = require('../lib/language')();

        var sbx = sandbox.clientInit(ctx, Date.now(), data);
        iage.setProperties(sbx);
        iage.updateVisualisation(sbx);

    });


    it('trigger a warning when insulin is 48 hours old', function (done) {
        ctx.notifications.initRequests();

        var before = Date.now() - (48 * 60 * 60 * 1000);

        ctx.ddata.insulinchangeTreatments = [{eventType: 'Insulin Change', mills: before}];

        var sbx = prepareSandbox();
        sbx.extendedSettings = { 'enableAlerts': 'TRUE' };
        iage.setProperties(sbx);
        iage.checkNotifications(sbx);

        var highest = ctx.notifications.findHighestAlarm('IAGE');
        highest.level.should.equal(levels.WARN);
        highest.title.should.equal('Insulin reservoir age 48 hours');
        done();
    });

});
