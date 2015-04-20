'use strict';

var consts = require('../../constants');

function configure (app, wares, food) {
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

    // List foods available
    api.get('/food/', function(req, res) {
        food.list(function (err, attribute) {
            return res.json(attribute);
        });
    });

    api.get('/food/quickpicks', function(req, res) {
        food.listquickpicks(function (err, attribute) {
            return res.json(attribute);
        });
    });

    api.get('/food/regular', function(req, res) {
        food.listregular(function (err, attribute) {
            return res.json(attribute);
        });
    });

    function config_authed (app, api, wares, food) {

        // create new record
        api.post('/food/', wares.verifyAuthorization, function(req, res) {
            var data = req.body;
            food.create(data, function (err, created) {
                if (err) {
                    res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
                    console.log('Error creating food');
                    console.log(err);
                } else {
                    res.json(created);
                    console.log('food created');
                }

            });
        });

        // update record
        api.put('/food/', wares.verifyAuthorization, function(req, res) {
            var data = req.body;
            food.save(data, function (err, created) {
                if (err) {
                    res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
                    console.log('Error saving food');
                    console.log(err);
                } else {
                    res.json(created);
                    console.log('food saved');
                }

            });
        });
		// delete record
		api.delete('/food/:_id', wares.verifyAuthorization, function(req, res) {
			food.remove(req.params._id, function ( ) {
			res.json({ });
		  });
		});
    }

    if (app.enabled('api')) {
        config_authed(app, api, wares, food);
    }

    return api;
}

module.exports = configure;

