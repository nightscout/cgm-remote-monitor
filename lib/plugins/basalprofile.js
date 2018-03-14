'use strict';
var times = require('../times');

function init() {

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
    
    var info = [{label: 'Current basal', value: prop.display}
      , {label: 'Current sensitivity', value: profile.getSensitivity(sbx.time) + ' ' + sbx.settings.units + '/ U'}
      , {label: 'Current carb ratio', value: '1 U /' + profile.getCarbRatio(sbx.time) + 'g'}
      , {label: 'Basal timezone', value: tzMessage}
      , {label: '------------', value: ''}
      , {label: 'Active profile', value: profile.activeProfileToTime(sbx.time)}
      ];

    var tempText, remaining;
    if (basalValue.treatment) {
      tempText = basalValue.treatment.percent ? (basalValue.treatment.percent > 0 ? '+' : '') + basalValue.treatment.percent + '%' :
        !isNaN(basalValue.treatment.absolute) ? basalValue.treatment.absolute + 'U/h' : '';
      remaining = parseInt(basalValue.treatment.duration - times.msecs(sbx.time - basalValue.treatment.mills).mins);
      info.push({label: '------------', value: ''});
      info.push({label: 'Active temp basal', value: tempText});
      info.push({label: 'Active temp basal start', value: new Date(basalValue.treatment.mills).toLocaleString()});
      info.push({label: 'Active temp basal duration', value: parseInt(basalValue.treatment.duration) + ' min'});
      info.push({label: 'Active temp basal remaining', value: remaining + ' min'});
      info.push({label: 'Basal profile value', value: basalValue.basal.toFixed(3) + ' U'});
    }
      
    if (basalValue.combobolustreatment) {
      tempText = (basalValue.combobolustreatment.relative ? '+' + basalValue.combobolustreatment.relative + 'U/h' : '');
      remaining = parseInt(basalValue.combobolustreatment.duration - times.msecs(sbx.time - basalValue.combobolustreatment.mills).mins);
      info.push({label: '------------', value: ''});
      info.push({label: 'Active combo bolus', value: tempText});
      info.push({label: 'Active combo bolus start', value: new Date(basalValue.combobolustreatment.mills).toLocaleString()});
      info.push({label: 'Active combo bolus duration', value: parseInt(basalValue.combobolustreatment.duration) + ' min'});
      info.push({label: 'Active combo bolus remaining', value: remaining + ' min'});
    }
      
    sbx.pluginBase.updatePillText(basal, {
      value: prop.display
      , label: 'BASAL'
      , info: info
    });

  };

  return basal;
}


module.exports = init;