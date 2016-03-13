'use strict';

var _ = require('lodash');
var express = require('express');
var sandbox = require('../sandbox')();

function create (env, ctx) {
  var properties = express( );

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

    console.info('>>>>url', req.url);
    console.info('>>>>query', req.query);
    console.info('>>>>segments', segments);
    console.info('>>>>selected', selected);

    var result = sbx.properties;

    if (selected.length > 0) {
      result = _.pick(sbx.properties, selected)
    }

    res.json(result);

  });


  return properties;
}

module.exports = create;