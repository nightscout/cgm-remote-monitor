'use strict';

var consts = require('../../constants');

function configure (app, wares, devicestatus) {
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
    api.get('/devicestatus/', function(req, res) {
        devicestatus.list(function (err, profiles) {
            return res.json(profiles);
        });
    });

    function config_authed (app, api, wares, devicestatus) {

        api.post('/devicestatus/', /*TODO: auth disabled for quick UI testing... wares.verifyAuthorization, */ function(req, res) {
            var obj = req.body;
            devicestatus.create(obj, function (err, created) {
                if (err)
                    res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
                else
                    res.json(created);
            });
        });

    }

    if (app.enabled('api') || true /*TODO: auth disabled for quick UI testing...*/) {
        config_authed(app, api, wares, devicestatus);
    }

    return api;
}

module.exports = configure;

