'use strict';

var moment = require('moment');
var _each = require('lodash/each');

function init(env, ctx) {
  function virtAsstBase() {
    return virtAsstBase;
  }

  var entries = ctx.entries;
  var translate = ctx.language.translate;

  virtAsstBase.setupMutualIntents = function (configuredPlugin) {
    // full status
    configuredPlugin.addToRollup('Status', function (slots, sbx, callback) {
      entries.list({count: 1}, function (err, records) {
        var direction;
        if (translate(records[0].direction)) {
          direction = translate(records[0].direction);
        } else {
          direction = records[0].direction;
        }
        var status = translate('virtAsstStatus', {
          params: [
            sbx.scaleMgdl(records[0].sgv),
            direction,
            moment(records[0].date).from(moment(sbx.time))
          ]
        });

        callback(null, {results: status, priority: -1});
      });
    }, 'BG Status');

    configuredPlugin.configureIntentHandler('NSStatus', function (callback, slots, sbx, locale) {
      configuredPlugin.getRollup('Status', sbx, slots, locale, function (status) {
        callback(translate('virtAsstTitleFullStatus'), status);
      });
    });

    // blood sugar and direction
    configuredPlugin.configureIntentHandler('MetricNow', function (callback, slots, sbx) {
      entries.list({count: 1}, function(err, records) {
        var direction;
        if(translate(records[0].direction)){
          direction = translate(records[0].direction);
        } else {
          direction = records[0].direction;
        }
        var status = translate('virtAsstStatus', {
          params: [
            sbx.scaleMgdl(records[0].sgv),
            direction,
            moment(records[0].date).from(moment(sbx.time))]
        });

        callback(translate('virtAsstTitleCurrentBG'), status);
      });
    }, ['bg', 'blood glucose', 'number']);
  };

  virtAsstBase.setupVirtAsstHandlers = function (configuredPlugin) {
    ctx.plugins.eachEnabledPlugin(function (plugin) {
      if (plugin.virtAsst) {
        if (plugin.virtAsst.intentHandlers) {
          console.log('Plugin "' + plugin.name + '" supports Virtual Assistants');
          _each(plugin.virtAsst.intentHandlers, function (route) {
            if (route) {
              configuredPlugin.configureIntentHandler(route.intent, route.intentHandler, route.metrics);
            }
          });
        }
        if (plugin.virtAsst.rollupHandlers) {
          console.log('Plugin "' + plugin.name + '" supports rollups for Virtual Assistants');
          _each(plugin.virtAsst.rollupHandlers, function (route) {
            if (route) {
              configuredPlugin.addToRollup(route.rollupGroup, route.rollupHandler, route.rollupName);
            }
          });
        }
      } else {
        console.log('Plugin "' + plugin.name + '" does not support Virtual Assistants');
      }
    });
  };

  return virtAsstBase;
}

module.exports = init;
