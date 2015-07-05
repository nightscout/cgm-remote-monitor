'use strict';

var consts = require('../../constants');

function configure (app, wares, treatments) {
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
    api.get('/treatments/', function(req, res) {
        treatments.list(req.query, function (err, profiles) {
            return res.json(profiles);
        });
    });

    function config_authed (app, api, wares, treatments) {

        function post_response(req, res) {
            var treatment = req.body;
            treatments.create(treatment, function (err, created) {
                if (err)
                    res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
                else
                    res.json(created);
            });
        }
		if (app.treatments_auth)
          api.post('/treatments/', wares.verifyAuthorization, post_response);
        else 
          api.post('/treatments/', post_response);
		
		api.delete('/treatments/:_id', wares.verifyAuthorization, function(req, res) {
			treatments.remove(req.params._id, function ( ) {
			res.json({ });
		  });
		});

       // update record
        api.put('/treatments/', wares.verifyAuthorization, function(req, res) {
            var data = req.body;
            treatments.save(data, function (err, created) {
                if (err) {
                    res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
                    console.log('Error saving treatment');
                    console.log(err);
                } else {
                    res.json(created);
                    console.log('Treatment saved');
                }

            });
        });
    }

    if (app.enabled('api') && app.enabled('careportal')) {
        config_authed(app, api, wares, treatments);
    }

    return api;
}

module.exports = configure;

