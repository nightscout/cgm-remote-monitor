'use strict';

var crypto = require('crypto');

var hashauth = {
   apisecret: ''
  , storeapisecret: false
  , apisecrethash: null
  , authenticated: false
  , initialized: false
};

hashauth.init = function init(client, $) {

  if (hashauth.initialized) {
    return hashauth;
  }

  hashauth.verifyAuthentication = function verifyAuthentication(next) {
    hashauth.authenticated = false;
    $.ajax({
      method: 'GET'
      , url: '/api/v1/verifyauth?t=' + Date.now() //cache buster
      , headers: client.headers()
    }).done(function verifysuccess (response) {
      if (response.message === 'OK') {
        hashauth.authenticated = true;
        console.log('Authentication passed.');
        next(true);
      } else {
        console.log('Authentication failed.', response);
        hashauth.removeAuthentication();
        next(false);
      }
    }).fail(function verifyfail (err) {
      console.log('Authentication failed.', err);
      hashauth.removeAuthentication();
      next(false);
    });
  };

  hashauth.injectHtml = function injectHtml ( ) {
    if (!hashauth.injectedHtml) {
      $('#authentication_placeholder').html(hashauth.inlineCode());
      hashauth.injectedHtml = true;
    }
  };

  hashauth.initAuthentication = function initAuthentication(next) {
    hashauth.apisecrethash = hashauth.apisecrethash || $.localStorage.get('apisecrethash') || null;
    hashauth.verifyAuthentication(function () {
      hashauth.injectHtml();
      if (next) { next( hashauth.isAuthenticated() ); }
    });
    return hashauth;
  };
  
  hashauth.removeAuthentication = function removeAuthentication(event) {

    $.localStorage.remove('apisecrethash');

    if (hashauth.authenticated) {
      client.browserUtils.reload();
    }

    // clear eveything just in case
    hashauth.apisecret = null;
    hashauth.apisecrethash = null;
    hashauth.authenticated = false;

    if (event) {
      event.preventDefault();
    }
    return false;
  };
  
  hashauth.requestAuthentication = function requestAuthentication (eventOrNext) {
    var translate = client.translate;
    hashauth.injectHtml();
    $( '#requestauthenticationdialog' ).dialog({
        width: 500
      , height: 240
      , buttons: [
        {
          text: translate('Update')
          , click: function() {
            var dialog = this;
            hashauth.processSecret($('#apisecret').val(), $('#storeapisecret').is(':checked'), function done (close) {
              if (close) {
                if (eventOrNext && eventOrNext.call) {
                  eventOrNext(true);
                } else {
                  client.afterAuth(true);
                }
                $( dialog ).dialog( 'close' );
              } else {
                $('#apisecret').val('').focus();
              }
            });
          }
        }
      ]
      , open: function open ( ) {
        $('#requestauthenticationdialog').keypress(function pressed (e) {
          if (e.keyCode === $.ui.keyCode.ENTER) {
            $(this).parent().find('button.ui-button-text-only').trigger('click');
          }
        });
        $('#apisecret').val('').focus();
      }

    });

    if (eventOrNext && eventOrNext.preventDefault) {
      eventOrNext.preventDefault();
    }
    return false;
  };
  
  hashauth.processSecret = function processSecret(apisecret, storeapisecret, callback) {
    var translate = client.translate;

    hashauth.apisecret = apisecret;
    hashauth.storeapisecret = storeapisecret;
    if (!hashauth.apisecret || hashauth.apisecret.length < 12) {
      window.alert(translate('Too short API secret'));
      if (callback) {
        callback(false);
      }
    } else {
      var shasum = crypto.createHash('sha1');
      shasum.update(hashauth.apisecret);
      hashauth.apisecrethash = shasum.digest('hex');

      hashauth.verifyAuthentication( function(isok) {
        if (isok) {
          if (hashauth.storeapisecret) {
            $.localStorage.set('apisecrethash',hashauth.apisecrethash);
          }
          $('#authentication_placeholder').html(hashauth.inlineCode());
          if (callback) {
            callback(true);
          }
        } else {
          alert(translate('Wrong API secret'));
          if (callback) {
            callback(false);
          }
        }
      });
    }
  };

  hashauth.inlineCode = function inlineCode() {
    var translate = client.translate;

    var status = null;

    if (client.authorized) {
      status = translate('Authorized by token') + ' <a href="/">(' + translate('view without token') + ')</a>' +
        '<br/><span class="small">' + client.authorized.sub + ': ' + client.authorized.permissionGroups.join(', ') + '</span>';
    } else if (hashauth.isAuthenticated()) {
      console.info('status isAuthenticated', hashauth);
      status = translate('Admin authorized') + ' <a href="#" onclick="Nightscout.client.hashauth.removeAuthentication(); return false;">(' + translate('Remove') + ')</a>';
    } else {
      status = translate('Unauthorized') + ' <a href="#" onclick="Nightscout.client.hashauth.requestAuthentication(); return false;">(' + translate('Authenticate') + ')</a>';
    }

    var html =
      '<div id="requestauthenticationdialog" style="display:none" title="'+translate('Device authentication')+'">'+
        '<label for="apisecret">'+translate('Your API secret')+': </label>'+
        '<input type="password" id="apisecret" size="20" />'+
        '<br>'+
        '<input type="checkbox" id="storeapisecret" /> <label for="storeapisecret">'+translate('Store hash on this computer (Use only on private computers)')+'</label>'+
        '<div id="apisecrethash">'+
        (hashauth.apisecrethash ? translate('Hash') + ' ' + hashauth.apisecrethash: '')+
        '</div>'+
      '</div>'+
      '<div id="authorizationstatus">' + status + '</div>';

    return html;
  };

  hashauth.updateSocketAuth = function updateSocketAuth() {
    client.socket.emit(
      'authorize'
      , {
        client: 'web'
        , secret: client.authorized && client.authorized.token ? null : client.hashauth.hash()
        , token: client.authorized && client.authorized.token
      }
      , function authCallback(data) {
        console.log('Client rights: ',data);
        if (!data.read && !client.authorized) {
          hashauth.requestAuthentication();
        }
      }
    );
  };

  hashauth.hash = function hash() {
    return hashauth.apisecrethash;
  };

  hashauth.isAuthenticated = function isAuthenticated() {
    return hashauth.authenticated;
  };

  hashauth.initialized = true;
  return hashauth;
};

module.exports = hashauth;
