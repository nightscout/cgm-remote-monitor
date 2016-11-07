'use strict';
var times = require('../times');

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
    
    var info = [{label: translate('Current basal'), value: prop.display}
      , {label: translate('Sensitivity'), value: profile.getSensitivity(sbx.time) + ' ' + sbx.settings.units + ' / U'}
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

  return basal;
}


module.exports = init;