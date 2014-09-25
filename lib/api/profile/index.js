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

    return api;
}

module.exports = configure;

