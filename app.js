'use strict';

var _ = require('lodash');
var express = require('express');
var compression = require('compression');
var bodyParser = require('body-parser');
var prettyjson = require('prettyjson');


function create(env, ctx) {
    var app = express();
    var appInfo = env.name + ' ' + env.version;
    app.set('title', appInfo);
    app.enable('trust proxy'); // Allows req.secure test on heroku https connections.

    if (ctx.bootErrors && ctx.bootErrors.length > 0) {
        app.get('*', require('./lib/booterror')(ctx));
        return app;
    }

    if (env.settings.isEnabled('cors')) {
        var allowOrigin = _.get(env, 'extendedSettings.cors.allowOrigin') || '*';
        console.info('Enabled CORS, allow-origin:', allowOrigin);
        app.use(function allowCrossDomain(req, res, next) {
            res.header('Access-Control-Allow-Origin', allowOrigin);
            res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With');

            // intercept OPTIONS method
            if ('OPTIONS' === req.method) {
                res.send(200);
            } else {
                next();
            }
        });
    }

    ///////////////////////////////////////////////////
    // api and json object variables
    ///////////////////////////////////////////////////
    var api = require('./lib/api/')(env, ctx);
    var ddata = require('./lib/data/endpoints')(env, ctx);

    app.use(compression({
        filter: function shouldCompress(req, res) {
            //TODO: return false here if we find a condition where we don't want to compress
            // fallback to standard filter function
            return compression.filter(req, res);
        }
    }));
    // app.use(bodyParser({limit: 1048576 * 50, extended: true }));

    //if (env.api_secret) {
    //    console.log("API_SECRET", env.api_secret);
    //}
    app.use('/api/v1', bodyParser({
        limit: 1048576 * 50
    }), api);

    app.use('/api/v2/properties', ctx.properties);
    app.use('/api/v2/authorization', ctx.authorization.endpoints);
    app.use('/api/v2/ddata', ddata);

    // pebble data
    app.get('/pebble', ctx.pebble);

    // expose swagger.yaml
    app.get('/swagger.yaml', function(req, res) {
        res.sendFile(__dirname + '/swagger.yaml');
    });

    if (env.settings.isEnabled('dumps')) {
        var heapdump = require('heapdump');
        app.get('/api/v2/dumps/start', function(req, res) {
            var path = new Date().toISOString() + '.heapsnapshot';
            path = path.replace(/:/g, '-');
            console.info('writing dump to', path);
            heapdump.writeSnapshot(path);
            res.send('wrote dump to ' + path);
        });
    }


    //app.get('/package.json', software);

    // Allow static resources to be cached for week
    var maxAge = 7 * 24 * 60 * 60 * 1000;

    if (process.env.NODE_ENV === 'development') {
        maxAge = 10;
        console.log('Development environment detected, setting static file cache age to 10 seconds');

        app.get('/nightscout.appcache', function(req, res) {
            res.sendStatus(404);
        });
    }

    //TODO: JC - changed cache to 1 hour from 30d ays to bypass cache hell until we have a real solution
    var staticFiles = express.static(env.static_files, {
        maxAge: maxAge
    });

    // serve the static content
    app.use(staticFiles);

    var tmpFiles = express.static('tmp', {
        maxAge: maxAge
    });

    // serve the static content
    app.use(tmpFiles);

    if (process.env.NODE_ENV !== 'development') {

        console.log('Production environment detected, enabling Minify');

        var minify = require('express-minify');
        var myUglifyJS = require('uglify-js');
        var myCssmin = require('cssmin');

        app.use(minify({
            js_match: /\.js/,
            css_match: /\.css/,
            sass_match: /scss/,
            less_match: /less/,
            stylus_match: /stylus/,
            coffee_match: /coffeescript/,
            json_match: /json/,
            uglifyJS: myUglifyJS,
            cssmin: myCssmin,
            cache: __dirname + '/cache',
            onerror: undefined,
        }));

    }

    // if this is dev environment, package scripts on the fly
    // if production, rely on postinstall script to run packaging for us

    if (process.env.NODE_ENV === 'development') {

        var webpack = require("webpack");
        var webpack_conf = require('./webpack.config');

        webpack(webpack_conf, function(err, stats) {

            var json = stats.toJson() // => webpack --json

            var options = {
                noColor: true
            };

            console.log(prettyjson.render(json.errors, options));
            console.log(prettyjson.render(json.assets, options));

        });
    }

    // Handle errors with express's errorhandler, to display more readable error messages.
    var errorhandler = require('errorhandler');
    //if (process.env.NODE_ENV === 'development') {
    app.use(errorhandler());
    //}
    return app;
}
module.exports = create;