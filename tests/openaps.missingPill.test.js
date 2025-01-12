'use strict';

const _ = require('lodash');
const should = require('should');
const helper = require('./inithelper')();
const openaps = require('../lib/plugins/openaps')(helper.getctx());
const sandbox = require('../lib/sandbox')(helper.getctx());

// Load test data
const missingRateOnLastEnacted = require('./data/missingRateOnLastEnacted.json');
const workingStatus = require('./data/statusWithWorkingForecast.json');

describe('OpenAPS Visualization Tests', function () {
    let ctx, now;

    beforeEach(function () {
        let top_ctx = helper.getctx();
        now = top_ctx.moment(missingRateOnLastEnacted[0].created_at);
        _.forEach(missingRateOnLastEnacted, function updateMills (status) {
            status.mills = top_ctx.moment(status.created_at).valueOf();
        });
        _.forEach(workingStatus, function updateMills (status) {
            status.mills = top_ctx.moment(status.created_at).valueOf();
        });
        ctx = {
            settings: {
                units: 'mg/dl',
            },
            pluginBase: {
                updatePillText: function mockedUpdatePillText(plugin, options) {
                    options.label.should.equal('OpenAPS ⌁');
                }
                , addForecastPoints: function mockAddForecastPoints (points) {
                    points.length.should.greaterThan(100);
                }
            },
            language: top_ctx.language,
            levels: top_ctx.levels,
        };
    });

    it('should correctly generate pill and prediction lines for working status', function (done) {
        const sbx = sandbox.clientInit(ctx, now.valueOf(), { devicestatus: workingStatus });
        openaps.setProperties(sbx);
        openaps.updateVisualisation(sbx);

        const result = sbx.properties.openaps;
        should.exist(result.lastPredBGs);
        result.lastPredBGs.UAM.should.be.an.Array();
        done();
    });

    it('should correctly generate pill and prediction lines for status without rate on last enacted', function (done) {
        const sbx = sandbox.clientInit(ctx, now.valueOf(), { devicestatus: missingRateOnLastEnacted });
        openaps.setProperties(sbx);
        openaps.updateVisualisation(sbx);

        const result = sbx.properties.openaps;
        should.exist(result.lastPredBGs);
        result.lastPredBGs.UAM.should.be.an.Array();
        done();
    });
});
