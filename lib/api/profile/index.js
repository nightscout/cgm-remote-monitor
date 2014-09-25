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

    // List settings available
    api.get('/profile/', function(req, res) {
        profile.list(function (err, attribute) {
            return res.json(attribute);
        });
    });

    function config_authed (app, api, wares, profile) {

        api.post('/profile/', /*TODO: auth disabled for now, need to get login figured out... wares.verifyAuthorization, */ function(req, res) {
            var attribute = req.body;
            profile.create(attribute, function (err, created) {
                if (err)
                    res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
                else
                    res.json(created);
            });
        });

    }

    if (app.enabled('api')) {
        config_authed(app, api, wares, profile);
    }

    return api;
}

module.exports = configure;

