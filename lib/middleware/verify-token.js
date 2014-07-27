'use strict';

var consts = require('../constants');
function configure (env) {
    function verifyAuthorization(req, res, next) {
        // Retrieve the secret values to be compared.
        var api_secret = env.api_secret;
        var secret = req.params.secret ? req.params.secret : req.header('API-SECRET');

        // Return an error message if the authorization fails.
        var unauthorized = (typeof api_secret === 'undefined' || secret != api_secret);
        if (unauthorized) {
            res.sendJSONStatus(res, consts.HTTP_UNAUTHORIZED, 'Unauthorized', 'API-SECRET Request Header is incorect or missing.');
        } else {
            next();
        }

        return unauthorized;
    }
    return verifyAuthorization;

}
module.exports = configure;
