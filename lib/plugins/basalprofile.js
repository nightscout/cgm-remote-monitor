'use strict';
var times = require('../times');

function init() {

  var basal = {
    name: 'basal'
    , label: 'Basal Profile'
    , pluginType: 'pill-minor'
    , additionalHtml: '<input type="checkbox" id="basals-switch" style="margin:0px 0px 0px 0px;vertical-align: bottom;">'
  };

  basal.htmlInitCode = function htmlInitCode () {
    $('#basals-switch').change(function switchChart (event) {
      window.Nightscout.client.chart.basals.attr('display', $('#basals-switch').is(':checked') ? '' : 'none');
      if (event) {
        event.preventDefault();
      }
    });
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
    
    var basalValue = profile.getTempBasal(sbx.time);
    var tempMark = basalValue.treatment ? 'T: ' : '';
        
    var tzMessage = profile.getTimezone() ? profile.getTimezone() : 'Timezone not set in profile';
    
    var info = [{label: 'Current basal', value: tempMark + basalValue.tempbasal + ' U'}
      , {label: 'Current sensitivity', value: profile.getSensitivity(sbx.time) + ' ' + sbx.settings.units + '/ U'}
      , {label: 'Current carb ratio', value: '1 U /' + profile.getCarbRatio(sbx.time) + 'g'}
      , {label: 'Basal timezone', value: tzMessage}
      , {label: '------------', value: ''}
      , {label: 'Active profile', value: profile.activeProfileToTime(sbx.time)}
      ];

    if (basalValue.treatment) {
      var tempText = (basalValue.treatment.percent ? (basalValue.treatment.percent > 0 ? '+' : '') + basalValue.treatment.percent + '%' : '') + (basalValue.treatment.absolute ? basalValue.treatment.absolute + 'U' : '');
      var remaining = parseInt(basalValue.treatment.duration - times.msecs(sbx.time - basalValue.treatment.mills).mins);
      info.push({label: '------------', value: ''});
      info.push({label: 'Active temp basal', value: tempText});
      info.push({label: 'Active temp basal start', value: new Date(basalValue.treatment.mills).toLocaleString()});
      info.push({label: 'Active temp basal duration', value: parseInt(basalValue.treatment.duration) + ' min'});
      info.push({label: 'Active temp basal remaining', value: remaining + ' min'});
    }
      
    sbx.pluginBase.updatePillText(basal, {
      value: tempMark + basalValue.tempbasal + 'U'
      , label: 'BASAL'
      , info: info
    });

  };

  return basal;
}


module.exports = init;