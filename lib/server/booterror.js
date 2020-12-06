'use strict';

const express = require('express');
const path = require('path');
var _ = require('lodash');

function bootError(env, ctx) {

  const app = new express();
  let locals = {};

  app.set('view engine', 'ejs');
  app.engine('html', require('ejs').renderFile);
  app.set("views", path.join(__dirname, "../../views/"));

  app.get('*', (req, res, next) => {

    if (req.url.includes('images')) return next();

    var errors = _.map(ctx.bootErrors, function (obj) {

      let message;

      if (typeof obj.err === 'string' || obj.err instanceof String) {
        message = obj.err;
      } else {
        message = JSON.stringify(_.pick(obj.err, Object.getOwnPropertyNames(obj.err)));
      }
      return '<dt><b>' + obj.desc + '</b></dt><dd>' + message.replace(/\\n/g, '<br/>') + '</dd>';
    }).join(' ');

    res.render('error.html', {
      errors,
      locals
    });

  });

  app.setLocals = function (_locals) {
    locals = _locals;
  }

  return app;
}

module.exports = bootError;