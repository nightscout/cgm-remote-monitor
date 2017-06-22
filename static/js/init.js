// don't 'use strict' since we're setting serverSettings globally
serverSettings = {
   'status':'unauthorized',
   'name':'Nightscout',
   'version':'unknown',
   'apiEnabled':false,
   'careportalEnabled':false,
   'boluscalcEnabled':false,
   'settings':{ },
   'extendedSettings':{ },
   'authorized':null
};

var params = {};
if (window.location.search) {
  window.location.search.substr(1).split('&').forEach(function(item) {
    params[item.split('=')[0]] = item.split('=')[1].replace(/[_\+]/g, ' ');
  });
}

var token = params.token;
var secret = $.localStorage.get('apisecrethash');

var script = window.document.createElement('script');
var src = '/api/v1/status.js?t=' + new Date().getTime();

if (secret) {
  src += '&secret=' + secret;
} else if (token) {
  src += '&token=' + token;
}
script.setAttribute('src', src);
window.document.body.appendChild(script);
