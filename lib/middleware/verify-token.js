'use strict';

var _ = require('lodash');
var consts = require('../constants');

function configure (env) {
    function verifyAuthorization(req, res, next) {
        // Retrieve the secret values to be compared.
        var api_secret = env.api_secret;

        var secret = req.params.secret ? req.params.secret : req.header('api-secret');

        // try to get the scret from the body, but don't leave it there
        if (!secret && req.body) {
          if (_.isArray(req.body) && req.body.length > 0) {
            secret = req.body[0].secret;
            delete req.body[0].secret;
          } else {
            secret = req.body.secret;
            delete req.body.secret;
          }
        }

        // Return an error message if the authorization fails.
        var authorized = (api_secret && api_secret.length > 12) ? (secret === api_secret) : false;
        if (!authorized) {
            res.sendJSONStatus(res, consts.HTTP_UNAUTHORIZED, 'Unauthorized', 'api-secret Request Header is incorrect or missing.');
        } else {
            next();
        }

        return authorized;
    }
    return verifyAuthorization;

}
module.exports = configure;
