'use strict';

function init() {

  var runtime = {
    name: 'runtimestate'
    , label: 'Runtime state'
    , pluginType: 'fake'
  };
  
  runtime.setProperties = function setProperties(sbx) {
    sbx.offerProperty('runtimestate', function setProp ( ) {
      return {
        state: sbx.runtimeState
      };
    });
  };

  return runtime;

}

module.exports = init;