'use strict';

var _ = require('lodash');

function init (ctx) {
  var translate = ctx.language.translate;

  var dbsize = {
    name: 'dbsize'
    , label: translate('Database Size')
    , pluginType: 'pill-status'
    , pillFlip: true
  };

  dbsize.getPrefs = function getPrefs (sbx) {
    return {
      warnPercentage: sbx.extendedSettings.warnPercentage ? sbx.extendedSettings.warnPercentage : 60
      , urgentPercentage: sbx.extendedSettings.urgentPercentage ? sbx.extendedSettings.urgentPercentage : 75
      , max: sbx.extendedSettings.max ? sbx.extendedSettings.max : 496
      , enableAlerts: sbx.extendedSettings.enableAlerts
      , inMib: sbx.extendedSettings.inMib
    };
  };

  dbsize.setProperties = function setProperties (sbx) {
    sbx.offerProperty('dbsize', function setDbsize () {
      return dbsize.analyzeData(sbx);
    });
  };

  dbsize.analyzeData = function analyzeData (sbx) {

    var prefs = dbsize.getPrefs(sbx);

    var recentData = sbx.data.dbstats;

    var result = {
      level: undefined
      , display: prefs.inMib ? '?MiB' : '?%'
      , status: undefined
    };

    var maxSize = (prefs.max > 0) ? prefs.max : 100 * 1024;
    var totalDataSize = (recentData && recentData.dataSize) ? recentData.dataSize : 0;
    totalDataSize += (recentData && recentData.indexSize) ? recentData.indexSize : 0;
    totalDataSize /= 1024 * 1024;

    var dataPercentage = Math.floor((totalDataSize * 100.0) / maxSize);

    result.totalDataSize = totalDataSize;
    result.dataPercentage = dataPercentage;
    result.notificationLevel = ctx.levels.INFO;
    result.details = {
        maxSize: parseFloat(maxSize.toFixed(2))
      , dataSize: parseFloat(totalDataSize.toFixed(2))
    };

    // failsafe to have percentage in 0..100 range
    var boundWarnPercentage = Math.max(0, Math.min(100, parseInt(prefs.warnPercentage)));
    var boundUrgentPercentage = Math.max(0, Math.min(100, parseInt(prefs.urgentPercentage)));

    var warnSize = Math.floor((boundWarnPercentage/100) * maxSize);
    var urgentSize = Math.floor((boundUrgentPercentage/100) * maxSize);

    if ((totalDataSize >= urgentSize)&&(boundUrgentPercentage > 0)) {
      result.notificationLevel = ctx.levels.URGENT;
    } else if ((totalDataSize >= warnSize)&&(boundWarnPercentage > 0)) {
      result.notificationLevel = ctx.levels.WARN;
    }

    result.display = prefs.inMib ? parseFloat(totalDataSize.toFixed(0)) + 'MiB' : dataPercentage + '%';
    result.status = ctx.levels.toStatusClass(result.notificationLevel);

    return result;
  };

  dbsize.checkNotifications = function checkNotifications (sbx) {
    var prefs = dbsize.getPrefs(sbx);

    if (!prefs.enableAlerts) { return; }

    var prop = sbx.properties.dbsize;

    if (prop.dataPercentage && prop.notificationLevel && prop.notificationLevel >= ctx.levels.WARN) {
      sbx.notifications.requestNotify({
        level: prop.notificationLevel
        , title: ctx.levels.toDisplay(prop.notificationLevel) + ' ' + translate('Database Size near its limits!')
        , message: translate('Database size is %1 MiB out of %2 MiB. Please backup and clean up database!', {
          params: [prop.details.dataSize, prop.details.maxSize]
        })
        , pushoverSound: 'echo'
        , group: 'Database Size'
        , plugin: dbsize
        , debug: prop
      });
    }
  };

  dbsize.updateVisualisation = function updateVisualisation (sbx) {
    var prop = sbx.properties.dbsize;

    var infos = [{
        label: translate('Data size')
        , value: translate('%1 MiB of %2 MiB (%3%)', {
          params: [prop.details.dataSize, prop.details.maxSize, prop.dataPercentage]
        })
        }
    ];

    sbx.pluginBase.updatePillText(dbsize, {
      value: prop && prop.display
      , labelClass: 'plugicon-database'
      , pillClass: prop && prop.status
      , info: infos
      , hide: !(prop && prop.totalDataSize && prop.totalDataSize >= 0)
    });
  };

  function virtAsstDatabaseSizeHandler (next, slots, sbx) {
    var display = _.get(sbx, 'properties.dbsize.display');
    if (display) {
      var dataSize = _.get(sbx, 'properties.dbsize.details.dataSize');
      var dataPercentage = _.get(sbx, 'properties.dbsize.dataPercentage');
      var response = translate('virtAsstDatabaseSize', {
        params: [
          dataSize
          , dataPercentage
        ]
      });
      next(translate('virtAsstTitleDatabaseSize'), response);
    } else {
      next(translate('virtAsstTitleDatabaseSize'), translate('virtAsstUnknown'));
    }
  }

  dbsize.virtAsst = {
    intentHandlers: [
      {
        intent: 'MetricNow'
        , metrics: ['db size']
        , intentHandler: virtAsstDatabaseSizeHandler
      }
    ]
  };

  return dbsize;

}

module.exports = init;
