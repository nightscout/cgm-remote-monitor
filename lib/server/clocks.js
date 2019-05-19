'use strict';

const express = require('express');
const path = require('path');

function clockviews(env, ctx) {

  const app = new express();

  app.set('view engine', 'ejs');
  app.engine('html', require('ejs').renderFile);
  app.set("views", path.join(__dirname, "../../views/clockviews/"));

  app.get('/:face', (req, res) => {

    const face = req.params.face;
    console.log('Clockface requested:', face);

    res.render('shared.html', {
      face
    });

  });

  return app;
}

module.exports = clockviews;