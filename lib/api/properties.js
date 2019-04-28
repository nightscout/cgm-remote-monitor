'use strict';

var _ = require('lodash');
var express = require('express');
var sandbox = require('../sandbox')();

function create (env, ctx) {
  var properties = express( );

  /**
   * Supports the paths:
   * /v2/properties - All properties
   * /v2/properties/prop1 - Only prop1
   * /v2/properties/prop1,prop3 - Only prop1 and prop3
   *
   * Expecting to define extended syntax and support for several query params
   */
  properties.get(['/', '/*'], function getProperties (req, res) {

    var sbx = sandbox.serverInit(env, ctx);

    ctx.plugins.setProperties(sbx);

    function notEmpty (part) {
      return ! _.isEmpty(part);
    }

    var segments = _.filter(req.url.split('/'), notEmpty);

    var selected = [ ];

    if (segments.length > 0) {
      selected = _.filter(segments[0].split(','), notEmpty);
    }

    var result = sbx.properties;

    if (selected.length > 0) {
      result = _.pick(sbx.properties, selected);
    }

    res.json(result);

  });


  return properties;
}

module.exports = create;