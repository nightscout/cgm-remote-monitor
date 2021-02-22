'use strict';

function init () {

  var bolus = {
    name: 'bolus'
    , label: 'Bolus'
    , pluginType: 'fake'
  };

  bolus.getPrefs = function getPrefs(sbx) {
    return {
      renderFormat: sbx.extendedSettings.renderFormat ? sbx.extendedSettings.renderFormat : 'default'
      , renderOver: sbx.extendedSettings.renderOver ? sbx.extendedSettings.renderOver : 0
      , notifyOver: sbx.extendedSettings.notifyOver ? sbx.extendedSettings.notifyOver : 0
    };
  };

  return bolus;
}

module.exports = init;