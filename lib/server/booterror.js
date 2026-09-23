'use strict';

const express = require('express');
const path = require('path');

var pick = require('../utils/pick');

function bootError(env, ctx) {

  const app = new express();
  let locals = {};

  app.set('view engine', 'ejs');
  app.engine('html', require('ejs').renderFile);
  app.set("views", path.join(__dirname, "../../views/"));

  app.get('*', (req, res, next) => {
    if (req.url.includes('images')) return next();

    var errors = ctx.bootErrors.map(function (obj) {

      let message;

      if (obj.err == null) {
        // A boot error may carry only a description; show that rather than
        // failing on Object.getOwnPropertyNames(undefined).
        message = '';
      } else if (typeof obj.err === 'string' || obj.err instanceof String) {
        message = obj.err;
      } else {
        message = JSON.stringify(pick(obj.err, Object.getOwnPropertyNames(obj.err)));
      }
      return '<dt><b>' + obj.desc + '</b></dt><dd>' + message.replace(/\\n/g, '<br/>') + '</dd>';
    }).join(' ');

    res.status(500).render('error.html', {
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