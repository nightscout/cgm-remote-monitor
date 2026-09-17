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
    let ctx, now, pillOptions;

    function updateMills (statuses) {
        let top_ctx = helper.getctx();
        _.forEach(statuses, function setMills (status) {
            status.mills = top_ctx.moment(status.created_at).valueOf();
        });
    }

    function visualize (statuses) {
        pillOptions = undefined;
        const sbx = sandbox.clientInit(ctx, now.valueOf(), { devicestatus: statuses });
        openaps.setProperties(sbx);
        openaps.updateVisualisation(sbx);
        return sbx.properties.openaps;
    }

    function pillText () {
        should.exist(pillOptions);
        return pillOptions.info.map(function getValue (item) {
            return item.value;
        }).join(' ');
    }

    beforeEach(function () {
        let top_ctx = helper.getctx();
        now = top_ctx.moment(missingRateOnLastEnacted[0].created_at);
        updateMills(missingRateOnLastEnacted);
        updateMills(workingStatus);
        ctx = {
            settings: {
                units: 'mg/dl',
            },
            pluginBase: {
                updatePillText: function mockedUpdatePillText(plugin, options) {
                    pillOptions = options;
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
        const result = visualize(workingStatus);
        should.exist(result.lastPredBGs);
        result.lastPredBGs.UAM.should.be.an.Array();
        done();
    });

    it('should correctly generate pill and prediction lines for status without rate on last enacted', function (done) {
        const result = visualize(missingRateOnLastEnacted);
        should.exist(result.lastPredBGs);
        result.lastPredBGs.UAM.should.be.an.Array();
        pillText().should.not.containEql('undefined');
        pillText().should.not.containEql('Temp Basal Started');
        done();
    });

    it('should not coerce blank or null temp basal details', function (done) {
        const missingDetails = [
            { rate: null },
            { rate: '' },
            { duration: null },
            { duration: '' }
        ];
        _.forEach(missingDetails, function checkMissingDetailValue (details) {
            const statuses = _.cloneDeep(workingStatus);
            _.assign(statuses[0].openaps.enacted, details);
            updateMills(statuses);
            visualize(statuses);
            pillText().should.not.containEql('Temp Basal Started');
            pillText().should.not.containEql('undefined');
        });
        done();
    });
});
