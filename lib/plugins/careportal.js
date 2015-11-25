'use strict';

// this is just a fake plugin to enable hiding from settings drawer

function init() {

  var careportal = {
    name: 'careportal'
    , label: 'Care Portal'
    , pluginType: 'drawer'
  };

  return careportal;
}

module.exports = init;