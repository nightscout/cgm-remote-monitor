'use strict';

var consts = require('../../constants');

function configure (app, wares, profile) {
    var express = require('express'),
        api = express.Router( );

    // invoke common middleware
    api.use(wares.sendJSONStatus);
    // text body types get handled as raw buffer stream
    api.use(wares.bodyParser.raw( ));
    // json body types get handled as parsed json
    api.use(wares.bodyParser.json( ));
    // also support url-encoded content-type
    api.use(wares.bodyParser.urlencoded({ extended: true }));

    // List profiles available
    api.get('/profile/', function(req, res) {
        profile.list(function (err, attribute) {
            return res.json(attribute);
        });
    });

    // List current active record (in current state LAST record is current active)
    api.get('/profile/current', function(req, res) {
        profile.last( function(err, records) {
            return res.json(records.length > 0 ? records[0] : null);
        });
    });

    function config_authed (app, api, wares, profile) {

        // create new record
        api.post('/profile/', wares.verifyAuthorization, function(req, res) {
            var data = req.body;
            profile.create(data, function (err, created) {
                if (err) {
                    res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
                    console.log('Error creating profile');
                    console.log(err);
                } else {
                    res.json(created);
                    console.log('Profile created');
                }

            });
        });

        // update record
        api.put('/profile/', wares.verifyAuthorization, function(req, res) {
            var data = req.body;
            profile.save(data, function (err, created) {
                if (err) {
                    res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
                    console.log('Error saving profile');
                    console.log(err);
                } else {
                    res.json(created);
                    console.log('Profile saved');
                }

            });
        });
    }

    if (app.enabled('api')) {
        config_authed(app, api, wares, profile);
    }

    return api;
}

module.exports = configure;

