'use strict';
var times = require('../times');
var moment = require('moment');

function init (ctx) {

  var translate = ctx.language.translate;

  var basal = {
    name: 'basal'
    , label: 'Basal Profile'
    , pluginType: 'pill-minor'
  };

  basal.setProperties = function setProperties (sbx) {
    if (hasRequiredInfo(sbx)) {
      var profile = sbx.data.profile;
      var current = profile.getTempBasal(sbx.time);

      var tempMark = '';
      tempMark += current.treatment ? 'T' : '';
      tempMark += current.combobolustreatment ? 'C' : '';
      tempMark += tempMark ? ': ' : '';

      sbx.offerProperty('basal', function setBasal() {
        return {
          display: tempMark + current.totalbasal.toFixed(3) + 'U'
          , current: current
        };
      });
    }
  };


  function hasRequiredInfo (sbx) {

    if (!sbx.data.profile) { return false; }
    
    if (!sbx.data.profile.hasData()) {
      console.warn('For the Basal plugin to function you need a treatment profile');
      return false;
    }
    
    if (!sbx.data.profile.getBasal()) {
      console.warn('For the Basal plugin to function you need a basal profile');
      return false;    
    }
    
    return true;
 }

  basal.updateVisualisation = function updateVisualisation (sbx) {
  
    if (!hasRequiredInfo(sbx)) {
      return;
    }
    
    var profile = sbx.data.profile;
    var prop = sbx.properties.basal;
    var basalValue =  prop && prop.current;
        
    var tzMessage = profile.getTimezone() ? profile.getTimezone() : 'Timezone not set in profile';
    
    var sensitivity = profile.getSensitivity(sbx.time);

    if (sbx.settings.units != profile.data[0].units) {
      sensitivity *= (sbx.settings.units === 'mmol' ? 0.055 : 18);
      var decimals = (sbx.settings.units === 'mmol' ? 10 : 1);

      sensitivity = Math.round(sensitivity * decimals) / decimals;
    }
    
    var info = [{label: translate('Current basal'), value: prop.display}
      , {label: translate('Sensitivity'), value: sensitivity + ' ' + sbx.settings.units + ' / U'}
      , {label: translate('Current Carb Ratio'), value: '1 U / ' + profile.getCarbRatio(sbx.time) + 'g'}
      , {label: translate('Basal timezone'), value: tzMessage}
      , {label: '------------', value: ''}
      , {label: translate('Active profile'), value: profile.activeProfileToTime(sbx.time)}
      ];

    var tempText, remaining;
    if (basalValue.treatment) {
      tempText = basalValue.treatment.percent ? (basalValue.treatment.percent > 0 ? '+' : '') + basalValue.treatment.percent + '%' :
        !isNaN(basalValue.treatment.absolute) ? basalValue.treatment.absolute + 'U/h' : '';
      remaining = parseInt(basalValue.treatment.duration - times.msecs(sbx.time - basalValue.treatment.mills).mins);
      info.push({label: '------------', value: ''});
      info.push({label: translate('Active temp basal'), value: tempText});
      info.push({label: translate('Active temp basal start'), value: new Date(basalValue.treatment.mills).toLocaleString()});
      info.push({label: translate('Active temp basal duration'), value: parseInt(basalValue.treatment.duration) + ' ' + translate('mins')});
      info.push({label: translate('Active temp basal remaining'), value: remaining + ' ' + translate('mins')});
      info.push({label: translate('Basal profile value'), value: basalValue.basal.toFixed(3) + ' U'});
    }
      
    if (basalValue.combobolustreatment) {
      tempText = (basalValue.combobolustreatment.relative ? '+' + basalValue.combobolustreatment.relative + 'U/h' : '');
      remaining = parseInt(basalValue.combobolustreatment.duration - times.msecs(sbx.time - basalValue.combobolustreatment.mills).mins);
      info.push({label: '------------', value: ''});
      info.push({label: translate('Active combo bolus'), value: tempText});
      info.push({label: translate('Active combo bolus start'), value: new Date(basalValue.combobolustreatment.mills).toLocaleString()});
      info.push({label: translate('Active combo bolus duration'), value: parseInt(basalValue.combobolustreatment.duration) + ' ' + translate('mins')});
      info.push({label: translate('Active combo bolus remaining'), value: remaining + ' ' + translate('mins')});
    }
      
    sbx.pluginBase.updatePillText(basal, {
      value: prop.display
      , label: translate('BASAL')
      , info: info
    });

  };

  function basalMessage(slots, sbx) {
        var basalValue = sbx.data.profile.getTempBasal(sbx.time);
        var response = 'Unable to determine current basal';
        var preamble = '';
        if (basalValue.treatment) {
            preamble = (slots && slots.pwd && slots.pwd.value) ? translate('alexaPreamble3person', {
                params: [
                    slots.pwd.value
                ]
            }) : translate('alexaPreamble');
            var minutesLeft = moment(basalValue.treatment.endmills).from(moment(sbx.time));
            response = translate('alexaBasalTemp', {
                params: [
                    preamble,
                    basalValue.totalbasal,
                    minutesLeft
                ]
            });
        } else {
            preamble = (slots && slots.pwd && slots.pwd.value) ? translate('alexaPreamble3person', {
                params: [
                    slots.pwd.value
                ]
            }) : translate('alexaPreamble');
            response = translate('alexaBasal', {
                params: [
                    preamble,
                    basalValue.totalbasal
                ]
            });
        }
        return response;
    }

  function alexaRollupCurrentBasalHandler (slots, sbx, callback) {
    callback(null, {results: basalMessage(slots, sbx), priority: 1});
  }

  function alexaCurrentBasalhandler (next, slots, sbx) {
    next('Current Basal', basalMessage(slots, sbx));
  }

  basal.alexa = {
    rollupHandlers: [{
      rollupGroup: 'Status'
      , rollupName: 'current basal'
      , rollupHandler: alexaRollupCurrentBasalHandler
    }],
    intentHandlers: [{
      intent: 'MetricNow'
      , routableSlot:'metric'
      , slots:['basal', 'current basal']
      , intentHandler: alexaCurrentBasalhandler
    }]
  };

  return basal;
}


module.exports = init;
