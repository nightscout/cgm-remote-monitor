'use strict';

const express = require('express');
const path = require('path');

function clockviews() {

  const app = new express();
  let locals = {};

  app.set('view engine', 'ejs');
  app.engine('html', require('ejs').renderFile);
  app.set("views", path.join(__dirname, "../../views/clockviews/"));

  app.get('/:face', (req, res) => {

    const face = req.params.face;
    console.log('Clockface requested:', face);

    res.render('clock.html', {
      face,
      locals
    });

  });

  app.setLocals = function (_locals) {
    locals = _locals;
  }

  return app;
}

module.exports = clockviews;