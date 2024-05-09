'use strict';

var consts = require('../../constants');

function configure (app, wares, ctx) {
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

    api.use(ctx.authorization.isPermitted('api:insulin:read'));
    // List profiles available
    api.get('/insulin/', function(req, res) {
        ctx.insulin.list(function (err, attribute) {
            return res.json(attribute);
        });
    });

    // List bolus insulin profile
    api.get('/insulin/bolus', function(req, res) {
        ctx.insulin.bolus( function(err, records) {
            return res.json(records.length > 0 ? records[0] : null);
        });
    });

    // List basal insulin profile
    api.get('/insulin/basal', function(req, res) {
        ctx.insulin.bolus( function(err, records) {
            return res.json(records.length > 0 ? records[0] : null);
        });
    });

    function config_authed (app, api, wares, ctx) {

        // create new record
        api.post('/insulin/', ctx.authorization.isPermitted('api:insulin:create'), async function(req, res) {
            var data = req.body;
            for (let i = 0, l = data.length; i < l; i++)
            {
                let result = await ctx.insulin.searchByName(data[i].name);
                if (result.length > 0)
                {
                        let err = "insulin profile with this name (" + data[i].name + ") already present - use update instead";
                        res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Data Error', err);
                        console.log('Error creating insulin');
                        console.log(err);
                        return;
                }
            }
            ctx.insulin.create(data, function (err, created) {
                if (err) {
                    res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
                    console.log('Error creating insulin');
                    console.log(err);
                } else {
                    res.json(created.ops);
                    console.log('Insulin created', created);
                }
            });
        });

        // update record
        api.put('/insulin/', ctx.authorization.isPermitted('api:insulin:update'), function(req, res) {
            var data = req.body;
            ctx.insulin.save(data, function (err, created) {
                if (err) {
                    res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
                    console.log('Error saving insulin');
                    console.log(err);
                } else {
                    res.json(created);
                    console.log('Insulin saved', created);
                }

            });
        });

        api.delete('/insulin/:_id', ctx.authorization.isPermitted('api:insulin:delete'), function(req, res) {
          ctx.insulin.remove(req.params._id, function ( ) {
            res.json({ });
          });
        });
    }

    if (app.enabled('api')) {
        config_authed(app, api, wares, ctx);
    }

    return api;
}

module.exports = configure;

