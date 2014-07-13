'use strict';

var consts = require('./constants');

function api (env, entries, settings) {

    var express = require('express'),
        api = express(),
        bodyParser = require('body-parser');

    var verifyAuthorization = require('./middleware/verify-token')(env);
    var sendJSONStatus = require('./middleware/send-json-status')( );
    api.set('title', 'Nightscout API v1');
    api.use(sendJSONStatus);
    api.use(bodyParser.json());
    api.use(require('express-extension-to-accept')([
      'json', 'svg', 'csv', 'txt', 'png', 'html', 'tsv'
    ]));
    api.use(bodyParser.urlencoded({
        extended: true
    }));

    api.get('/authorized/:secret/test', verifyAuthorization, function (req, res, next) {
        return res.json({status: 'ok'});
    });

    api.get('/authorized/test', verifyAuthorization, function (req, res, next) {
        return res.json({status: 'ok'});
    });

    api.get('/status', function (req, res, next) {
        var status = {status: 'ok'};
        var badge = 'http://img.shields.io/badge/Nightscout-OK-green';
        return res.format({
          html: function ( ) {
            res.send("<h1>STATUS OK</h1>");
          },
          png: function ( ) {
            res.redirect(302, badge + '.png');
          },
          svg: function ( ) {
            res.redirect(302, badge + '.svg');
          },
          text: function ( ) {
            res.send("STATUS OK");
          },
          json: function ( ) {
            res.json(status);
          }
        });
        return res.json({status: 'ok'});
    });

    api.get('/entries', function(req, res) {
        console.log('body', req.body);
        console.log('params', req.params);
        console.log('query', req.query);
        // If "?count=" is present, use that number to decided how many to return.
        var count = parseInt(req.query.count, 0) || consts.ENTRIES_DEFAULT_COUNT;
        var query = { count: count };
        entries.list(query, function(err, entries) {
          if (err)
              res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
          else
              return res.json(entries);
        });
        return;
    });

    api.get('/entries/current', function(req, res) {
        entries.list({count: 1}, function(err, entries) {
          if (err)
              res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
          else
              return res.json(entries);
        });
        return;
    });

    api.get('/entries/:id', function(req, res) {
        console.log('body', req.body);
        console.log('params', req.params);
        console.log('query', req.query);
        entries.getEntry(function(err, entry) {
            if (err)
                res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
            else
                return res.json(entry);
        }, req.params.id);
    });

    api.get('/settings', function(req, res) {
        console.log('body', req.body);
        console.log('params', req.params);
        console.log('query', req.query);
        settings.getSettings(function(err, settings) {
            if (err)
                res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
            else
                return res.json(settings);
        });
    });

    api.delete('/settings', verifyAuthorization, function(req, res) {
      settings.remove(function ( ) {
        res.json({ });
      });
    });
    api.put('/settings', verifyAuthorization, function(req, res) {
        // Retrieve the JSON formatted record.
        var json = req.body;
        console.log(req.body, json);

        
        // Send the new settings to mongodb.
        settings.updateSettings(json, function(err, config) {
            if (err)
                res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
            else {
                // Add a warning to the outgoing status when HTTPS is not being used.
                var warning = '';
                if (req.secure === false)
                    warning = 'WARNING: HTTPS is required to secure your data!';
                
                res.json(config);
            }
        });
    });

    return api;
}
module.exports = api;

