'use strict';

function create (env, ctx, apiv1) {
  var express = require('express')
    ,  app = express( )
    ;

    const ddata = require('../data/endpoints')(env, ctx);
    const notificationsV2 = require('./notifications-v2')(app, ctx);
    const easyState = require('./easystate')(env, ctx);

    app.use('/', apiv1);
    app.use('/properties', ctx.properties);
    app.use('/authorization', ctx.authorization.endpoints);
    app.use('/ddata', ddata);
    app.use('/notifications', notificationsV2);
    app.use('/easystate', easyState);
    
  return app;
}

module.exports = create;
