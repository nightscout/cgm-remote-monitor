'use strict';

const express = require('express')
  , fs = require('fs')
  ;


function setupSwaggerUI (app) {

  const serveSwaggerDef = function serveSwaggerDef (req, res) {
    res.sendFile(__dirname + '/swagger.yaml');
  };
  app.get('/swagger', serveSwaggerDef);

  const swaggerUiAssetPath = require('swagger-ui-dist').getAbsoluteFSPath();
  const swaggerFiles = express.static(swaggerUiAssetPath);

  const urlRegex = /url: "[^"]*",/;

  const patchIndex = function patchIndex (req, res) {
    const indexContent = fs.readFileSync(`${swaggerUiAssetPath}/index.html`)
      .toString()
      .replace(urlRegex, 'url: "../swagger.yaml",');
    res.send(indexContent);
  };

  app.get('/swagger-ui-dist', function getSwaggerRoot (req, res) {
    let targetUrl = req.originalUrl;
    if (!targetUrl.endsWith('/')) {
      targetUrl += '/';
    }
    targetUrl += 'index.html';
    res.redirect(targetUrl);
  });
  app.get('/swagger-ui-dist/index.html', patchIndex);

  app.use('/swagger-ui-dist', swaggerFiles);
}


module.exports = setupSwaggerUI;