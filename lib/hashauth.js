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
        console.log('Authentication failed.');
        hashauth.removeAuthentication();
        next(false);
      }
    }).fail(function verifyfail ( ) {
      console.log('Authentication failed.');
      hashauth.removeAuthentication();
      next(false);
    });
  };
  
  hashauth.initAuthentication = function initAuthentication(next) {
    hashauth.apisecrethash = $.localStorage.get('apisecrethash') || null;
    hashauth.verifyAuthentication(function () {
      $('#authentication_placeholder').html(hashauth.inlineCode());
      if (next) { next( hashauth.isAuthenticated() ); }
    });
    return hashauth;
  };
  
  hashauth.removeAuthentication = function removeAuthentication(event) {
    hashauth.apisecret = null;
    hashauth.apisecrethash = null;
    hashauth.authenticated = false;

    if (hashauth.isAuthenticated()) {
      $.localStorage.remove('apisecrethash');
      client.browserUtils.reload();
    }

    if (event) {
      event.preventDefault();
    }
    return false;
  };
  
  hashauth.requestAuthentication = function requestAuthentication(event) {
    var translate = client.translate;

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
                client.afterAuth(true);
                $( dialog ).dialog( 'close' );
              } else {
                $('#apisecret').val('').focus();
              }
            });
          }
        }
      ]
      , open: function open ( ) {
        $("#requestauthenticationdialog").keypress(function(e) {
          if (e.keyCode == $.ui.keyCode.ENTER) {
            $(this).parent().find('button.ui-button-text-only').trigger('click');
          }
        });
        $('#apisecret').val('').focus();
      }

    });
    if (event) {
      event.preventDefault();
    }
    return false;
  };
  
  hashauth.processSecret = function processSecret(apisecret, storeapisecret, callback) {
    var translate = client.translate;

    hashauth.apisecret = apisecret;
    hashauth.storeapisecret = storeapisecret;
    if (hashauth.apisecret.length < 12) {
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
          hashauth.updateSocketAuth();
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
      '<div id="authorizationstatus">'+
        (hashauth.isAuthenticated() ? 
          translate('Device authenticated') + ' <a href="#" onclick="Nightscout.client.hashauth.removeAuthentication(); return false;">(' + translate('Remove') + ')</a>'
          :
          translate('Device not authenticated') + ' <a href="#" onclick="Nightscout.client.hashauth.requestAuthentication(); return false;">(' + translate('Authenticate') + ')</a>'
        )+
      '</div>';

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
