'use strict';

function init() {

  var basal = {
    name: 'basal'
    , label: 'Basal Profile'
    , pluginType: 'pill-minor'
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
    
    var basalValue = profile.getBasal(sbx.time);
        
    var tzMessage = profile.getTimezone() ? profile.getTimezone() : 'Timezone not set in profile';
    
    var info = [{label: 'Current basal:', value: basalValue + ' U'}
      , {label: 'Current sensitivity:', value: profile.getSensitivity(sbx.time) + ' ' + sbx.settings.units + '/ U'}
      , {label: 'Current carb ratio:', value: '1 U /' + profile.getCarbRatio(sbx.time) + 'g'}
      , {label: 'Basal timezone:', value: tzMessage}
      ];

    sbx.pluginBase.updatePillText(basal, {
      value: basalValue + 'U'
      , label: 'BASAL'
      , info: info
    });

  };

  return basal;
}


module.exports = init;