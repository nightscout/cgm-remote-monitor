'use strict';

function requireSSL(req, res, next) {
    // Are we currently secure?
    var secure = req.secure;
    
    // If we are not secure display a warming. message.
    if (secure === false) {
        // Define the user to the Secure version of the current URL.
        var secureUrl = 'https://' + req.hostname + req.baseUrl + req.url;
        console.log('WARNING: To encrypt your data, please use ' + secureUrl + '.');
        next(); //res.status(401).send('<h1>HTTPS Required.</h1>SSL ecryption is required to secure your data. ( Use this URL instead: ' + secureUrl + ' )');
    } else {
        next();
    }

}
function configure ( ) {
  return requireSSL;
}
module.exports = configure;

