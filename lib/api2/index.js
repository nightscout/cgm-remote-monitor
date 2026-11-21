'use strict';

function create (env, ctx, apiv1, { compatibilityOnly = false } = {}) {
  var express = require('express')
    ,  app = express( )
    ;

  require('../middleware/configure-request')(app);

    app.use('/', apiv1);
    if (compatibilityOnly) return app;
    const ddata = require('../data/endpoints')(env, ctx);
    const notificationsV2 = require('./notifications-v2')(app, ctx, env);
    const summary = require('./summary')(env, ctx);

    app.use('/properties', ctx.properties);
    app.use('/authorization', ctx.authorization.endpoints);
    app.use('/ddata', ddata);
    app.use('/notifications', notificationsV2);
    app.use('/summary', summary);
    
  return app;
}

module.exports = create;
