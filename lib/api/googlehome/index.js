'use strict';

var _ = require('lodash');
var moment = require('moment');

function configure (app, wares, ctx, env) {
    var express = require('express');
    var api = express.Router();
    var entries = ctx.entries;

    // invoke common middleware
    api.use(wares.sendJSONStatus);
    // text body types get handled as raw buffer stream
    api.use(wares.bodyParser.raw());
    // json body types get handled as parsed json
    api.use(wares.bodyParser.json());

    ctx.plugins.eachEnabledPlugin(function each(plugin) {
      if (plugin.googleHome) {
        if (plugin.googleHome.intentHandlers) {
          console.log('Plugin ' + plugin.name + ' is Google Home enabled');
          _.each(plugin.googleHome.intentHandlers, function (handler) {
            if (handler) {
              ctx.googleHome.configureIntentHandler(handler.intent, handler.intentHandler, handler.routableSlot, handler.slots);
            }
          });
        }
      } else {
        console.log('Plugin ' + plugin.name + ' is not Google Home enabled');
      }
    });

    ctx.googleHome.configureIntentHandler('CurrentMetric', function (result, next, sbx) {
      entries.list({count: 1}, function(err, records) {
        var response = '';
        if (records && records.length > 0) {
          var direction = '';
          if (records[0].direction === 'FortyFiveDown') {
            direction = ' y bajando lentamente';
          } else if (records[0].direction === 'FortyFiveUp') {
            direction = ' y subiendo lentamente';
          } else if (records[0].direction === 'Flat') {
            direction = ' y estable';
          } else if (records[0].direction === 'SingleUp') {
            direction = ' y subiendo';
          } else if (records[0].direction === 'SingleDown') {
            direction = ' y bajando';
          } else if (records[0].direction === 'DoubleDown') {
            direction = ' y bajando rápidamente';
          } else if (records[0].direction === 'DoubleUp') {
            direction = ' y subiendo rápidamente';
          }
          response = buildPreamble(result.parameters);
          response += sbx.scaleMgdl(records[0].sgv) + direction + ' hace ' + moment(records[0].date).from(moment(sbx.time));
        } else {
          response = buildPreamble(result.parameters) + 'unknown';
        }
        next(response);
      });
    }, 'metric', ['bg', 'blood glucose', 'blood sugar', 'number']);

    api.post('/googlehome', ctx.authorization.isPermitted('api:*:read'), function (req, res, next) {
      console.log('Incoming request from Google Home');
      onIntent(req.body, function (response) {
        res.json(ctx.googleHome.buildResponse(response));
        next();
      });
    });

    function buildPreamble(parameters) {
      var preamble = '';
      if (parameters && parameters.givenName) {
        preamble = parameters.givenName + '\'s current ';
      } else {
        preamble = 'Estás ';
      }
      if (parameters && parameters.readingType) {
        preamble += parameters.readingType + ' is ';
      } else {
        preamble += 'a ';
      }
      return preamble;
    }

    function onIntent(body, next) {
      console.log('Received intent request');
      console.log(JSON.stringify(body));
      handleIntent(body, next);
    }

    // https://docs.api.ai/docs/webhook#section-format-of-request-to-the-service
    function handleIntent(body, next) {
      var displayName = body.queryResult.intent.displayName;
      var metric = body.queryResult.parameters ? body.queryResult.parameters.metric : null;
      var handler = ctx.googleHome.getIntentHandler(displayName, metric);
      if (handler) {
        var sbx = initializeSandbox();
        handler(body.queryResult, next, sbx);
      } else {
        next('I\'m sorry I don\'t know what you\'re asking for');
      }
    }

    function initializeSandbox() {
      var sbx = require('../../sandbox')();
      sbx.serverInit(env, ctx);
      ctx.plugins.setProperties(sbx);
      return sbx;
    }

    return api;
}

module.exports = configure;
