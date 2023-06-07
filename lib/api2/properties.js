'use strict';

var _isEmpty = require('lodash/isEmpty');
var _filter = require('lodash/filter');
var _pick = require('lodash/pick');

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
  properties.use(ctx.authorization.isPermitted('api:entries:read'),
    ctx.authorization.isPermitted('api:treatments:read'));
  properties.get(['/', '/*'], function getProperties (req, res) {

    if (!ctx.sbx) res.json({});

    function notEmpty (part) {
      return ! _isEmpty(part);
    }

    var segments = _filter(req.path.split('/'), notEmpty);

    var selected = [ ];

    if (segments.length > 0) {
      selected = _filter(segments[0].split(','), notEmpty);
    }

    var result = ctx.sbx.properties;

    if (selected.length > 0) {
      result = _pick(ctx.sbx.properties, selected);
    }

    result = env.settings.filteredSettings(result);
    
    if (req.query && req.query.pretty) {
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(result, null, 2));
    } else {
      res.json(result);
    }

  });


  return properties;
}

module.exports = create;
