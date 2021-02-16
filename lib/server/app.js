'use strict';

const _get = require('lodash/get');
const express = require('express');
const compression = require('compression');
const bodyParser = require('body-parser');
const randomToken = require('random-token');

const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

function resolvePath(filePath) {

  if (fs.existsSync(filePath)) return filePath;
  let p = path.join(__dirname, filePath);
  if (fs.existsSync(p)) return p;
  p = path.join(process.cwd(), filePath);
  if (fs.existsSync(p)) return p;

  return require.resolve(filePath);
}

function create (env, ctx) {
  var app = express();
  var appInfo = env.name + ' ' + env.version;
  app.set('title', appInfo);
  app.enable('trust proxy'); // Allows req.secure test on heroku https connections.
  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: true }));
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

      const enableCSP = env.secureCsp ? true : false;

      let cspPolicy = false;

      if (enableCSP) {
        var secureCspReportOnly = env.secureCspReportOnly;
        if (secureCspReportOnly) {
          console.info('Enabled SECURE_CSP (Content Security Policy header). Not enforcing. Report only.');
        } else {
          console.info('Enabled SECURE_CSP (Content Security Policy header). Enforcing.');
        }

        let frameAncestors = ["'self'"];

        for (let i = 0; i <= 8; i++) {
          let u = env.settings['frameUrl' + i];
          if (u) {
            frameAncestors.push(u);
          }
        }

        cspPolicy = { //TODO make NS work without 'unsafe-inline'
          directives: {
            defaultSrc: ["'self'"]
            , styleSrc: ["'self'", 'https://fonts.googleapis.com/', 'https://fonts.gstatic.com/', "'unsafe-inline'"]
            , scriptSrc: ["'self'", "'unsafe-inline'"]
            , fontSrc: ["'self'", 'https://fonts.googleapis.com/', 'https://fonts.gstatic.com/', 'data:']
            , imgSrc: ["'self'", 'data:']
            , objectSrc: ["'none'"] // Restricts <object>, <embed>, and <applet> elements
            , reportUri: '/report-violation'
            , baseUri: ["'none'"] // Restricts use of the <base> tag
            , formAction: ["'self'"] // Restricts where <form> contents may be submitted
            , connectSrc: ["'self'", "ws:", "wss:", 'https://fonts.googleapis.com/', 'https://fonts.gstatic.com/']
            , frameSrc: ["'self'"]
            , frameAncestors: frameAncestors
          }
          , reportOnly: secureCspReportOnly
        };
      }


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
        , contentSecurityPolicy: cspPolicy
      }));

      if (enableCSP) {

        app.use(helmet.referrerPolicy({ policy: 'no-referrer' }));
        app.use(bodyParser.json({ type: ['json', 'application/csp-report'] }));
        app.post('/report-violation', (req, res) => {
          if (req.body) {
            console.log('CSP Violation: ', req.body);
          } else {
            console.log('CSP Violation: No data received!');
          }
          res.status(204).end();
        })
      }
    }
  } else {
    console.info('Security settings: INSECURE_USE_HTTP=', insecureUseHttp, ', SECURE_HSTS_HEADER=', secureHstsHeader);
  }

  app.set('view engine', 'ejs');
  app.engine('html', require('ejs').renderFile);
  app.set("views", resolvePath('/views'));

  let cacheBuster = process.env.NODE_ENV == 'development' ? 'developmentMode': randomToken(16);
  app.locals.cachebuster = cacheBuster;

  let lastModified = new Date();

  app.get("/robots.txt", (req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.send(['User-agent: *','Disallow: /'].join('\n'));
  });

  const swcontent = fs.readFileSync(resolvePath('/views/service-worker.js'), { encoding: 'utf-8' });

  app.get("/sw.js", (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    if (process.env.NODE_ENV !== 'development') {
      res.setHeader('Last-Modified', lastModified.toUTCString());
    }
    res.send(ejs.render(swcontent, { locals: app.locals} ));
  });

  // Allow static resources to be cached for week
  var maxAge = 7 * 24 * 60 * 60 * 1000;

  if (process.env.NODE_ENV === 'development') {
    maxAge = 1;
    console.log('Development environment detected, setting static file cache age to 1 second');
  }

  var staticFiles = express.static(resolvePath(env.static_files), {
    maxAge
  });

  // serve the static content
  app.use(staticFiles);

  app.use('/translations', express.static(resolvePath('/translations'), {
    maxAge
  }));

  if (ctx.bootErrors && ctx.bootErrors.length > 0) {
    const bootErrorView = require('./booterror')(env, ctx);
    bootErrorView.setLocals(app.locals);
    app.get('*', bootErrorView);
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
  const apiRoot = require('../api/root')(env, ctx);
  var api = require('../api/')(env, ctx);
  var api3 = require('../api3/')(env, ctx);
  var ddata = require('../data/endpoints')(env, ctx);
  var notificationsV2 = require('../api/notifications-v2')(app, ctx);

  app.use(compression({
    filter: function shouldCompress (req, res) {
      //TODO: return false here if we find a condition where we don't want to compress
      // fallback to standard filter function
      return compression.filter(req, res);
    }
  }));

  var appPages = {
    "/": {
      file: "index.html"
      , type: "index"
    }
    , "/admin": {
      file: "adminindex.html"
      , title: 'Admin Tools'
      , type: 'admin'
    }
    , "/food": {
      file: "foodindex.html"
      , title: 'Food Editor'
      , type: 'food'
    }
    , "/profile": {
      file: "profileindex.html"
      , title: 'Profile Editor'
      , type: 'profile'
    }
    , "/report": {
      file: "reportindex.html"
      , title: 'Nightscout reporting'
      , type: 'report'
    }
    , "/split": {
      file: "frame.html"
      , title: '8-user view'
      , type: 'index'
    }
  };

  Object.keys(appPages).forEach(function(page) {
    app.get(page, (req, res) => {
      res.render(appPages[page].file, {
        locals: app.locals,
        title: appPages[page].title ? appPages[page].title : '',
        type: appPages[page].type ? appPages[page].type : '',
        settings: env.settings
      });
    });
  });

  const clockviews = require('./clocks.js')(env, ctx);
  clockviews.setLocals(app.locals);

  app.use("/clock", clockviews);

  app.use('/api', apiRoot);

  app.use('/api/v1', api);

  app.use('/api/v2', api);

  app.use('/api/v2/properties', ctx.properties);
  app.use('/api/v2/authorization', ctx.authorization.endpoints);
  app.use('/api/v2/ddata', ddata);
  app.use('/api/v2/notifications', notificationsV2);

  app.use('/api/v3', api3);

  // pebble data
  app.get('/pebble', ctx.pebble);

  const swaggerjson = fs.readFileSync(resolvePath(__dirname + '/swagger.json'), { encoding: 'utf-8' });
  const swaggeryaml = fs.readFileSync(resolvePath(__dirname + '/swagger.yaml'), { encoding: 'utf-8' });

  // expose swagger.json
  app.get('/swagger.json', function(req, res) {
    res.setHeader("Content-Type", 'application/json');
    res.send(swaggerjson);
  });

  // expose swagger.yaml
  app.get('/swagger.yaml', function(req, res) {
    res.setHeader("Content-Type", 'text/vnd.yaml');
    res.send(swaggeryaml);
  });

  // API docs

  const swaggerUi = require('swagger-ui-express');
  const swaggerUseSchema = schema => (...args) => swaggerUi.setup(schema)(...args);
  const swaggerDocument = require('./swagger.json');
  const swaggerDocumentApiV3 = require('../api3/swagger.json');

  app.use('/api-docs', swaggerUi.serve, swaggerUseSchema(swaggerDocument));
  app.use('/api3-docs', swaggerUi.serve, swaggerUseSchema(swaggerDocumentApiV3));

  app.use('/swagger-ui-dist', (req, res) => {
    res.redirect(307, '/api-docs');
  });

  // if this is dev environment, package scripts on the fly
  // if production, rely on postinstall script to run packaging for us

  app.locals.bundle = '/bundle';
  app.locals.mode = 'production';

  if (process.env.NODE_ENV === 'development') {

    console.log('Development mode');

    app.locals.mode = 'development';
    app.locals.bundle = '/devbundle';

    const webpack = require('webpack');
    var webpack_conf = require('../../webpack.config');
    const middleware = require('webpack-dev-middleware');
    const compiler = webpack(webpack_conf);

    app.use(
      middleware(compiler, {
        // webpack-dev-middleware options
        publicPath: webpack_conf.output.publicPath
      })
    );

    app.use(require("webpack-hot-middleware")(compiler, {
      heartbeat: 1000
    }));
  }

  // Production bundling
  const tmpFiles =  express.static(resolvePath('/tmp/public'), {
    maxAge: maxAge
  });

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
      , cache: resolvePath('/tmp/public')
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
