'use strict';

var _ = require('lodash');

function init() {

  function basal() {
    return basal;
  }

  basal.label = 'Basal Profile';
  basal.pluginType = 'pill-minor';

  function hasRequiredInfo (sbx) {

    if (!sbx.data.profile) return false;
    
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
    
    var basalValue = sbx.data.profile.getBasal(sbx.time);
    
    var info = [{label: 'Current basal:', value: basalValue + ' IU'}
      , {label: 'Current sensitivity:', value: sbx.data.profile.getSensitivity(sbx.time) + ' ' + sbx.units + '/ IU'}
      , {label: 'Current carb ratio:', value: '1 IU /' + sbx.data.profile.getCarbRatio(sbx.time) + 'g'}
      ];

    sbx.pluginBase.updatePillText(basal, basalValue + 'U', 'BASAL', info);

  };

  return basal();
}


module.exports = init;