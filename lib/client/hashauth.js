'use strict';

var Storages = require('js-storage');

function canUseSubtleCrypto () {
  return typeof window !== 'undefined'
    && window.crypto
    && window.crypto.subtle
    && typeof window.crypto.subtle.digest === 'function'
    && typeof TextEncoder !== 'undefined';
}

function bytesToHex (bytes) {
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var byteHex = bytes[i].toString(16);
    hex += byteHex.length === 1 ? '0' + byteHex : byteHex;
  }
  return hex;
}

function wordToHex (word) {
  var hex = (word >>> 0).toString(16);
  return '00000000'.slice(hex.length) + hex;
}

function rotateLeft (value, bits) {
  return (value << bits) | (value >>> (32 - bits));
}

function utf8Bytes (value) {
  if (typeof TextEncoder !== 'undefined') {
    return Array.prototype.slice.call(new TextEncoder().encode(value));
  }

  var bytes = [];
  for (var i = 0; i < value.length; i++) {
    var codePoint = value.charCodeAt(i);

    if (codePoint >= 0xD800 && codePoint <= 0xDBFF) {
      var next = value.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        codePoint = 0x10000 + ((codePoint - 0xD800) << 10) + (next - 0xDC00);
        i++;
      } else {
        codePoint = 0xFFFD;
      }
    } else if (codePoint >= 0xDC00 && codePoint <= 0xDFFF) {
      codePoint = 0xFFFD;
    }

    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(
        0xC0 | (codePoint >> 6)
        , 0x80 | (codePoint & 0x3F)
      );
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xE0 | (codePoint >> 12)
        , 0x80 | ((codePoint >> 6) & 0x3F)
        , 0x80 | (codePoint & 0x3F)
      );
    } else {
      bytes.push(
        0xF0 | (codePoint >> 18)
        , 0x80 | ((codePoint >> 12) & 0x3F)
        , 0x80 | ((codePoint >> 6) & 0x3F)
        , 0x80 | (codePoint & 0x3F)
      );
    }
  }
  return bytes;
}

function sha1Fallback (value) {
  var bytes = utf8Bytes(value);
  var bitLength = bytes.length * 8;

  bytes.push(0x80);
  while ((bytes.length % 64) !== 56) {
    bytes.push(0);
  }

  var bitLengthHigh = Math.floor(bitLength / 0x100000000);
  var bitLengthLow = bitLength >>> 0;
  bytes.push(
    (bitLengthHigh >>> 24) & 0xFF
    , (bitLengthHigh >>> 16) & 0xFF
    , (bitLengthHigh >>> 8) & 0xFF
    , bitLengthHigh & 0xFF
    , (bitLengthLow >>> 24) & 0xFF
    , (bitLengthLow >>> 16) & 0xFF
    , (bitLengthLow >>> 8) & 0xFF
    , bitLengthLow & 0xFF
  );

  var h0 = 0x67452301;
  var h1 = 0xEFCDAB89;
  var h2 = 0x98BADCFE;
  var h3 = 0x10325476;
  var h4 = 0xC3D2E1F0;

  for (var offset = 0; offset < bytes.length; offset += 64) {
    var words = [];
    for (var i = 0; i < 16; i++) {
      var index = offset + (i * 4);
      words[i] = (
        (bytes[index] << 24)
        | (bytes[index + 1] << 16)
        | (bytes[index + 2] << 8)
        | bytes[index + 3]
      );
    }

    for (i = 16; i < 80; i++) {
      words[i] = rotateLeft(words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16], 1);
    }

    var a = h0;
    var b = h1;
    var c = h2;
    var d = h3;
    var e = h4;

    for (i = 0; i < 80; i++) {
      var f;
      var k;

      if (i < 20) {
        f = (b & c) | ((~b) & d);
        k = 0x5A827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ED9EBA1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8F1BBCDC;
      } else {
        f = b ^ c ^ d;
        k = 0xCA62C1D6;
      }

      var temp = (rotateLeft(a, 5) + f + e + k + words[i]) | 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  return wordToHex(h0) + wordToHex(h1) + wordToHex(h2) + wordToHex(h3) + wordToHex(h4);
}

async function sha1Hex (value) {
  if (canUseSubtleCrypto()) {
    try {
      var encoded = new TextEncoder().encode(value);
      var hashBuffer = await window.crypto.subtle.digest('SHA-1', encoded);
      return bytesToHex(new Uint8Array(hashBuffer));
    } catch (error) {
      console.warn('Falling back to JavaScript SHA-1 implementation:', error);
    }
  }

  return sha1Fallback(value);
}

var hashauth = {
  initialized: false
};

hashauth.init = function init (client, $) {

  hashauth.apisecret = '';
  hashauth.storeapisecret = false;
  hashauth.apisecrethash = null;
  hashauth.authenticated = false;
  hashauth.tokenauthenticated = false;
  hashauth.hasReadPermission = false;
  hashauth.isAdmin = false;
  hashauth.hasWritePermission = false;
  hashauth.permissionlevel = 'NONE';

  hashauth.verifyAuthentication = function verifyAuthentication (next) {
    hashauth.authenticated = false;
    $.ajax({
      method: 'GET'
      , url: '/api/v1/verifyauth?t=' + Date.now() //cache buster
      , headers: client.headers()
    }).done(function verifysuccess (response) {


      var message = response.message;

      if (message.canRead) { hashauth.hasReadPermission = true; }
      if (message.canWrite) { hashauth.hasWritePermission = true; }
      if (message.isAdmin) { hashauth.isAdmin = true; }
      if (message.permissions) { hashauth.permissionlevel = message.permissions; }

      if (message.rolefound == 'FOUND') {
        hashauth.tokenauthenticated = true;
        console.log('Token Authentication passed.');
        next(true);
        return;
      }

      if (response.message === 'OK' || message.message === 'OK') {
        hashauth.authenticated = true;
        console.log('Authentication passed.');
        next(true);
        return;
      }

      console.log('Authentication failed!', response);
      hashauth.removeAuthentication();
      next(false);
      return;

    }).fail(function verifyfail (err) {
      console.log('Authentication failure', err);
      hashauth.removeAuthentication();
      next(false);
    });
  };

  hashauth.injectHtml = function injectHtml () {
    if (!hashauth.injectedHtml) {
      $('#authentication_placeholder').html(hashauth.inlineCode());
      hashauth.injectedHtml = true;
    }
  };

  hashauth.initAuthentication = function initAuthentication (next) {
    hashauth.apisecrethash = hashauth.apisecrethash || Storages.localStorage.get('apisecrethash') || null;
    hashauth.verifyAuthentication(function() {
      hashauth.injectHtml();
      if (next) { next(hashauth.isAuthenticated()); }
    });
    return hashauth;
  };

  hashauth.removeAuthentication = function removeAuthentication (event) {

    Storages.localStorage.remove('apisecrethash');

    if (hashauth.authenticated || hashauth.tokenauthenticated) {
      client.browserUtils.reload();
    }

    // clear everything just in case
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

    var clientWidth = window.innerWidth ||
      document.documentElement.clientWidth ||
      document.body.clientWidth;

    clientWidth = Math.min(400, clientWidth);

    $('#requestauthenticationdialog').dialog({
      width: clientWidth
      , height: 270
      , closeText: ''
      , buttons: [
        {
          id: 'requestauthenticationdialog-btn'
          , text: translate('Authenticate')
          , click: function() {
            var dialog = this;
            hashauth.processSecret($('#apisecret').val(), $('#storeapisecret').is(':checked'), function done (close) {
              if (close) {
                if (eventOrNext && eventOrNext.call) {
                  eventOrNext(true);
                } else {
                  client.afterAuth(true);
                }
                $(dialog).dialog('close');
              } else {
                $('#apisecret').val('').focus();
              }
            });
          }
        }
      ]
      , open: function open () {
        $('#apisecret').off('keyup').on('keyup', function pressed (e) {
          if (e.keyCode === $.ui.keyCode.ENTER) {
            $('#requestauthenticationdialog-btn').trigger('click');
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

  hashauth.processSecret = async function processSecret (apisecret, storeapisecret, callback) {
    var translate = client.translate;

    hashauth.apisecret = apisecret;
    hashauth.storeapisecret = storeapisecret;
    if (!hashauth.apisecret || hashauth.apisecret.length < 12) {
      window.alert(translate('Too short API secret'));
      if (callback) {
        callback(false);
      }
    } else {
      try {
        hashauth.apisecrethash = await sha1Hex(hashauth.apisecret);

        hashauth.verifyAuthentication(function(isok) {
          if (isok) {
            if (hashauth.storeapisecret) {
              Storages.localStorage.set('apisecrethash', hashauth.apisecrethash);
              // TODO show dialog first, then reload
              if (hashauth.tokenauthenticated) client.browserUtils.reload();
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
      } catch (error) {
        console.error('Error hashing API secret:', error);
        if (callback) {
          callback(false);
        }
      }
    }
  };

  hashauth.inlineCode = function inlineCode () {
    var translate = client.translate;

    var status = null;

    if (!hashauth.isAdmin) {
      $('.needsadminaccess').hide();
    } else {
      $('.needsadminaccess').show();
    }

    if (client.updateAdminMenu) client.updateAdminMenu();

    if (client.authorized || hashauth.tokenauthenticated) {
      status = translate('Authorized by token');
      if (client.authorized && client.authorized.sub) {
        status += '<br>' + translate('Auth role') + ': ' + client.authorized.sub;
        if (hashauth.hasReadPermission) {  status += '<br>' + translate('Data reads enabled'); }
        if (hashauth.hasWritePermission) { status += '<br>' + translate('Data writes enabled'); }
        if (!hashauth.hasWritePermission) { status += '<br>' + translate('Data writes not enabled'); }
      }
      if (hashauth.apisecrethash) {
        status += '<br> <a href="#" onclick="Nightscout.client.hashauth.removeAuthentication(); return false;">(' + translate('Remove stored token') + ')</a>';
      } else {
        status += '<br><a href="/">(' + translate('view without token') + ')</a>';
      }

    } else if (hashauth.isAuthenticated()) {
      status = translate('Admin authorized') + ' <a href="#" onclick="Nightscout.client.hashauth.removeAuthentication(); return false;">(' + translate('Remove') + ')</a>';
    } else {
      status = translate('Unauthorized') +
        '<br>' +
        translate('Reads enabled in default permissions') +
        '<br>' +
        ' <a href="#" onclick="Nightscout.client.hashauth.requestAuthentication(); return false;">(' +
        translate('Authenticate') + ')</a>';
    }

    var html =
      '<div id="requestauthenticationdialog" style="display:none" title="' + translate('Device authentication') + '">' +
      '<label for="apisecret">' + translate('Your API secret or token') + ': </label>' +
      '<input type="password" id="apisecret" size="20" style="width: 100%;"/>' +
      '<br>' +
      '<input type="checkbox" id="storeapisecret" /> <label for="storeapisecret">' + translate('Remember this device. (Do not enable this on public computers.)') + '</label>' +
      '</div>' +
      '<div id="authorizationstatus">' + status + '</div>';

    return html;
  };

  hashauth.updateSocketAuth = function updateSocketAuth () {
    client.socket.emit(
      'authorize'
      , {
        client: 'web'
        , secret: client.authorized && client.authorized.token ? null : client.hashauth.hash()
        , token: client.authorized && client.authorized.token
      }
      , function authCallback (data) {
        if (!data.read && !client.authorized) {
          hashauth.requestAuthentication();
        }
      }
    );
  };

  hashauth.hash = function hash () {
    return hashauth.apisecrethash;
  };

  hashauth.isAuthenticated = function isAuthenticated () {
    return hashauth.authenticated || hashauth.tokenauthenticated;
  };

  hashauth.initialized = true;

  return hashauth;
}

module.exports = hashauth;
