'use strict';

const _get = require('lodash/get');
const express = require('express');
const compression = require('compression');
const bodyParser = require('body-parser');

const path = require('path');
const fs = require('fs');

function create (env, ctx) {
  var app = express();
  var appInfo = env.name + ' ' + env.version;
  app.set('title', appInfo);
  app.enable('trust proxy'); // Allows req.secure test on heroku https connections.
  var insecureUseHttp = env.insecureUseHttp;
  var secureHstsHeader = env.secureHstsHeader;
  if (!insecureUseHttp) {
    console.info('Redirecting http traffic to https because INSECURE_USE_HTTP=', insecureUseHttp);
    app.use((req, res, next) => {
      if (req.header('x-forwarded-proto') === 'https' || req.secure) {
        next();
      } else {
        res.redirect(307, `https://${req.header('host')}${req.url}`);
      }
    });
    if (secureHstsHeader) { // Add HSTS (HTTP Strict Transport Security) header
      console.info('Enabled SECURE_HSTS_HEADER (HTTP Strict Transport Security)');
      const helmet = require('helmet');
      var includeSubDomainsValue = env.secureHstsHeaderIncludeSubdomains;
      var preloadValue = env.secureHstsHeaderPreload;
      app.use(helmet({
        hsts: {
          maxAge: 31536000
          , includeSubDomains: includeSubDomainsValue
          , preload: preloadValue
        }
        , frameguard: false
      }));
      if (env.secureCsp) {
        var secureCspReportOnly = env.secureCspReportOnly;
        if (secureCspReportOnly) {
          console.info('Enabled SECURE_CSP (Content Security Policy header). Not enforcing. Report only.');
        } else {
          console.info('Enabled SECURE_CSP (Content Security Policy header). Enforcing.');
        }
        app.use(helmet.contentSecurityPolicy({ //TODO make NS work without 'unsafe-inline'
          directives: {
            defaultSrc: ["'self'"]
            , styleSrc: ["'self'", 'https://fonts.googleapis.com/', "'unsafe-inline'"]
            , scriptSrc: ["'self'", "'unsafe-inline'"]
            , fontSrc: ["'self'", 'https://fonts.gstatic.com/', 'data:']
            , imgSrc: ["'self'", 'data:']
            , objectSrc: ["'none'"], // Restricts <object>, <embed>, and <applet> elements
            reportUri: '/report-violation'
            , frameAncestors: ["'none'"], // Clickjacking protection, using frame-ancestors
            baseUri: ["'none'"], // Restricts use of the <base> tag
            formAction: ["'self'"], // Restricts where <form> contents may be submitted
          }
          , reportOnly: secureCspReportOnly
        }));
        app.use(helmet.referrerPolicy({ policy: 'no-referrer' }));
        app.use(helmet.featurePolicy({ features: { payment: ["'none'"], } }));
        app.use(bodyParser.json({ type: ['json', 'application/csp-report'] }));
        app.post('/report-violation', (req, res) => {
          if (req.body) {
            console.log('CSP Violation: ', req.body)
          } else {
            console.log('CSP Violation: No data received!')
          }
          res.status(204).end()
        })
      }
    }
  } else {
    console.info('Security settings: INSECURE_USE_HTTP=', insecureUseHttp, ', SECURE_HSTS_HEADER=', secureHstsHeader);
  }

  app.set('view engine', 'ejs');
  // this allows you to render .html files as templates in addition to .ejs
  app.engine('html', require('ejs').renderFile);
  app.engine('appcache', require('ejs').renderFile);
  app.set("views", path.join(__dirname, "views/"));

  let cacheBuster = 'developmentMode';
  if (process.env.NODE_ENV !== 'development') {
    if (fs.existsSync(process.cwd() + '/tmp/cacheBusterToken')) {
      cacheBuster = fs.readFileSync(process.cwd() + '/tmp/cacheBusterToken').toString().trim();
    } else {
      cacheBuster = fs.readFileSync(__dirname + '/tmp/cacheBusterToken').toString().trim();
    }
  }
  app.locals.cachebuster = cacheBuster;

  if (ctx.bootErrors && ctx.bootErrors.length > 0) {
    app.get('*', require('./lib/server/booterror')(ctx));
    return app;
  }

  if (env.settings.isEnabled('cors')) {
    var allowOrigin = _get(env, 'extendedSettings.cors.allowOrigin') || '*';
    console.info('Enabled CORS, allow-origin:', allowOrigin);
    app.use(function allowCrossDomain (req, res, next) {
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
    var api3 = require('./lib/api3/')(env, ctx);
    var ddata = require('./lib/data/endpoints')(env, ctx);

  app.use(compression({
    filter: function shouldCompress (req, res) {
      //TODO: return false here if we find a condition where we don't want to compress
      // fallback to standard filter function
      return compression.filter(req, res);
    }
  }));

  const clockviews = require('./lib/server/clocks.js')(env, ctx);
  clockviews.setLocals(app.locals);

  app.use("/clock", clockviews);

  app.get("/", (req, res) => {
    res.render("index.html", {
      locals: app.locals
    });
  });

  var appPages = {
    "/clock-color.html": "clock-color.html"
    , "/admin": "adminindex.html"
    , "/profile": "profileindex.html"
    , "/food": "foodindex.html"
    , "/bgclock.html": "bgclock.html"
    , "/report": "reportindex.html"
    , "/translations": "translationsindex.html"
    , "/clock.html": "clock.html"
  };

  Object.keys(appPages).forEach(function(page) {
    app.get(page, (req, res) => {
      res.render(appPages[page], {
        locals: app.locals
      });
    });
  });

  app.get("/appcache/*", (req, res) => {
    res.render("nightscout.appcache", {
      locals: app.locals
    });
  });

  app.use('/api/v1', bodyParser({
    limit: 1048576 * 50
  }), api);

  app.use('/api/v2/properties', ctx.properties);
  app.use('/api/v2/authorization', ctx.authorization.endpoints);
  app.use('/api/v2/ddata', ddata);

  app.use('/api/v3', api3);

  // pebble data
  app.get('/pebble', ctx.pebble);

  // expose swagger.json
  app.get('/swagger.json', function(req, res) {
    res.sendFile(__dirname + '/swagger.json');
  });

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

  // app.get('/package.json', software);

  // Allow static resources to be cached for week
  var maxAge = 7 * 24 * 60 * 60 * 1000;

  if (process.env.NODE_ENV === 'development') {
    maxAge = 1;
    console.log('Development environment detected, setting static file cache age to 1 second');

    app.get('/nightscout.appcache', function(req, res) {
      res.sendStatus(404);
    });
  }

  var staticFiles = express.static(env.static_files, {
    maxAge
  });

  // serve the static content
  app.use(staticFiles);

  // API docs

  const swaggerUi = require('swagger-ui-express');
  const swaggerDocument = require('./swagger.json');

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

  app.use('/swagger-ui-dist', (req, res, next) => {
    res.redirect(307, '/api-docs');
  });

  // if this is dev environment, package scripts on the fly
  // if production, rely on postinstall script to run packaging for us

  app.locals.bundle = '/bundle';

  if (process.env.NODE_ENV === 'development') {

    console.log('Development mode');

    app.locals.bundle = '/devbundle';

    const webpack = require('webpack');
    var webpack_conf = require('./webpack.config');
    const middleware = require('webpack-dev-middleware');
    const compiler = webpack(webpack_conf);

    app.use(
      middleware(compiler, {
        // webpack-dev-middleware options
        publicPath: webpack_conf.output.publicPath
        , lazy: false
      })
    );

    app.use(require("webpack-hot-middleware")(compiler, {
      heartbeat: 1000
    }));
  }

  // Production bundling
  var tmpFiles;
  if (fs.existsSync(process.cwd() + '/tmp/cacheBusterToken')) {
    tmpFiles = express.static('tmp', {
      maxAge: maxAge
    });
  } else {
    tmpFiles = express.static(__dirname + '/tmp', {
      maxAge: maxAge
    });
  }

  // serve the static content
  app.use('/bundle', tmpFiles);

  if (process.env.NODE_ENV !== 'development') {

    console.log('Production environment detected, enabling Minify');

    var minify = require('express-minify');
    var myCssmin = require('cssmin');

    app.use(minify({
      js_match: /\.js/
      , css_match: /\.css/
      , sass_match: /scss/
      , less_match: /less/
      , stylus_match: /stylus/
      , coffee_match: /coffeescript/
      , json_match: /json/
      , cssmin: myCssmin
      , cache: __dirname + '/tmp'
      , onerror: undefined
    , }));

  }

  // Handle errors with express's errorhandler, to display more readable error messages.
  var errorhandler = require('errorhandler');
  //if (process.env.NODE_ENV === 'development') {
  app.use(errorhandler());
  //}
  return app;
}
module.exports = create;
