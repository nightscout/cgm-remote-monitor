'use strict';

var moment = require('moment');
var _each = require('lodash/each');

function configure (app, wares, ctx, env) {
  var entries = ctx.entries;
  var express = require('express')
    , api = express.Router( );
  var translate = ctx.language.translate;

  // invoke common middleware
  api.use(wares.sendJSONStatus);
  // text body types get handled as raw buffer stream
  api.use(wares.bodyParser.raw());
  // json body types get handled as parsed json
  api.use(wares.bodyParser.json());

  ctx.plugins.eachEnabledPlugin(function each(plugin){
    if (plugin.virtAsst) {
      if (plugin.virtAsst.intentHandlers) {
        console.log('Google Home: Plugin ' + plugin.name + ' supports Virtual Assistants');
        _each(plugin.virtAsst.intentHandlers, function (route) {
          if (route) {
            ctx.googleHome.configureIntentHandler(route.intent, route.intentHandler, route.metrics);
          }
        });
      }
      if (plugin.virtAsst.rollupHandlers) {
        console.log('Google Home: Plugin ' + plugin.name + ' supports rollups for Virtual Assistants');
        _each(plugin.virtAsst.rollupHandlers, function (route) {
          console.log('Route');
          console.log(route);
          if (route) {
            ctx.googleHome.addToRollup(route.rollupGroup, route.rollupHandler, route.rollupName);
          }
        });
      }
    } else {
      console.log('Google Home: Plugin ' + plugin.name + ' does not support Virtual Assistants');
    }
  });

  api.post('/googlehome', ctx.authorization.isPermitted('api:*:read'), function (req, res, next) {
    console.log('Incoming request from Google Home');
    var locale = req.body.queryResult.languageCode;
    if(locale){
      if(locale.length > 2) {
        locale = locale.substr(0, 2);
      }
      ctx.language.set(locale);
      moment.locale(locale);
    }

    var handler = ctx.googleHome.getIntentHandler(req.body.queryResult.intent.displayName, req.body.queryResult.parameters.metric);
    if (handler){
      var sbx = initializeSandbox();
      handler(function (title, response) {
        res.json(ctx.googleHome.buildSpeechletResponse(response, false));
        next( );
      }, req.body.queryResult.parameters, sbx);
    } else {
      res.json(ctx.googleHome.buildSpeechletResponse('I\'m sorry. I don\'t know what you\'re asking for. Could you say that again?', true));
      next( );
    }
  });

  ctx.googleHome.addToRollup('Status', function bgRollupHandler(slots, sbx, callback) {
    entries.list({count: 1}, function (err, records) {
      var direction;
      if (translate(records[0].direction)) {
        direction = translate(records[0].direction);
      } else {
        direction = records[0].direction;
      }
      var status = translate('virtAsstStatus', {
        params: [
          sbx.scaleMgdl(records[0].sgv),
          direction,
          moment(records[0].date).from(moment(sbx.time))
        ]
      });
      
      callback(null, {results: status, priority: -1});
    });
  }, 'BG Status');

  ctx.googleHome.configureIntentHandler('MetricNow', function (callback, slots, sbx, locale) {
    entries.list({count: 1}, function(err, records) {
      var direction;
      if(translate(records[0].direction)){
        direction = translate(records[0].direction);
      } else {
        direction = records[0].direction;
      }
      var status =  translate('virtAsstStatus', {
        params: [
          sbx.scaleMgdl(records[0].sgv),
          direction,
          moment(records[0].date).from(moment(sbx.time))]
      });
      
      callback(translate('virtAsstTitleCurrentBG'), status);
    });
  }, ['bg', 'blood glucose', 'number']);

  ctx.googleHome.configureIntentHandler('MetricNow', function (callback, slots, sbx, locale) {
    if (sbx.properties.delta && sbx.properties.delta.display) {
      entries.list({count: 2}, function(err, records) {
        callback(
          translate('virtAsstTitleDelta'),
          translate('virtAsstDelta', {
            params: [
              sbx.properties.delta.display == '+0' ? '0' : sbx.properties.delta.display,
              moment(records[0].date).from(moment(sbx.time)),
              moment(records[1].date).from(moment(sbx.time))
            ]
          })
        );
      });
    } else {
      callback(translate('virtAsstTitleDelta'), translate('virtAsstUnknown'));
    }
  }, ['delta']);

  ctx.googleHome.configureIntentHandler('NSStatus', function (callback, slots, sbx, locale) {
    ctx.googleHome.getRollup('Status', sbx, slots, locale, function (status) {
      callback(translate('virtAsstTitleFullStatus'), status);
    });
  });

  function initializeSandbox() {
    var sbx = require('../../sandbox')();
    sbx.serverInit(env, ctx);
    ctx.plugins.setProperties(sbx);
    return sbx;
  }

  return api;
}

module.exports = configure;