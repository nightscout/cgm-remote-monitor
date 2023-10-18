'use strict';

var _forEach = require('lodash/forEach');
var _isNil = require('lodash/isNil');
var _isArray = require('lodash/isArray');

var consts = require('../../constants');
var moment = require('moment');

function configure(app, wares, ctx) {
    var express = require('express')
        , api = express.Router();

    api.use(wares.compression());
    // text body types get handled as raw buffer stream
    api.use(wares.rawParser);
    // json body types get handled as parsed json
    api.use(wares.bodyParser.json({
      limit: '50Mb'
    }));
    // also support url-encoded content-type
    api.use(wares.urlencodedParser);
    // invoke common middleware
    api.use(wares.sendJSONStatus);

    api.use(ctx.authorization.isPermitted('api:activity:read'));

    // List activity data available
    api.get('/activity', function(req, res) {
        var ifModifiedSince = req.get('If-Modified-Since');
        ctx.activity.list(req.query, function(err, results) {
            var d1 = null;
            
            _forEach(results, function clean(t) {

                var d2 = null;
                
                if (Object.prototype.hasOwnProperty.call(t, 'created_at')) {
                  d2 = new Date(t.created_at);
                } else {
                  if (Object.prototype.hasOwnProperty.call(t, 'timestamp')) {
                    d2 = new Date(t.timestamp);
                  }
                }
                
                if (d2 == null) { return; }
                                
                if (d1 == null || d2.getTime() > d1.getTime()) {
                    d1 = d2;
                }
            });
            
            if (!_isNil(d1)) res.setHeader('Last-Modified', d1.toUTCString());

            if (ifModifiedSince && d1.getTime() <= moment(ifModifiedSince).valueOf()) {
                res.status(304).send({
                    status: 304
                    , message: 'Not modified'
                    , type: 'internal'
                });
                return;
            } else {
                return res.json(results);
            }
        });
    });

    function config_authed(app, api, wares, ctx) {

        function post_response(req, res) {
            var activity = req.body;

            if (!_isArray(activity)) {
                activity = [activity];
            }

            ctx.activity.create(activity, function(err, created) {
                if (err) {
                    console.log('Error adding activity data', err);
                    res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
                } else {
                    console.log('Activity measure created');
                    res.json(created);
                }
            });
        }

        api.post('/activity/', ctx.authorization.isPermitted('api:activity:create'), post_response);

        api.delete('/activity/:_id', ctx.authorization.isPermitted('api:activity:delete'), function(req, res) {
            ctx.activity.deleteOne(req.params._id, function() {
                res.json({});
            });
        });

        // update record
        api.put('/activity/', ctx.authorization.isPermitted('api:activity:update'), function(req, res) {
            var data = req.body;
            ctx.activity.save(data, function(err, created) {
                if (err) {
                    res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
                    console.log('Error saving activity');
                    console.log(err);
                } else {
                    res.json(created);
                    console.log('Activity measure saved', data);
                }
            });
        });
    }

    if (app.enabled('api') && app.enabled('careportal')) {
        config_authed(app, api, wares, ctx);
    }

    return api;
}

module.exports = configure;

