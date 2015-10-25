'use strict';

function init() {

  var basal = {
    name: 'basal'
    , label: 'Basal Profile'
    , pluginType: 'pill-minor'
    , additionalHtml: '<select id="basal-mode" style="width: 10px; font-size: 5px;">'
      +    '<option class="translate" value="none">Hidden</option>'
      +    '<option class="translate" value="default">Default</option>'
      +    '<option class="translate" value="icicle">Icicle</option>'
      +  '</select>'
  };

  //TODO: some refactoring needed here, should be using pluginBase more, move jquery out
  //TODO: stop using window here
  basal.htmlInitCode = function htmlInitCode (pluginBase) {
    var basalSwitch = $('#basal-mode');
    var basalDisplayAttr = 'basal-chart-mode';

    function toDisplayAttr (mode) {
      return !mode || 'none' === mode ? 'none' : '';
    }

    var mode = pluginBase.getFromStorage(basalDisplayAttr, 'none');
    basalSwitch.val(mode);
    window.Nightscout.client.chart.basals.attr('display', toDisplayAttr(mode));

    basalSwitch.change(function switchChart ( ) {
      var mode = basalSwitch.val();
      window.Nightscout.client.chart.basals.attr('display', toDisplayAttr(mode));
      if ('none' !== toDisplayAttr(mode)) {
        window.Nightscout.client.chart.setBasalMode(mode)
      }
      pluginBase.setInStorage(basalDisplayAttr, mode);
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