(function () {
  'use strict';
  //for the tests window isn't the global object
  var $ = window.$;
  var _ = window._;
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;

  if (serverSettings === undefined) {
    console.error('server settings were not loaded, will not call init');
  } else {
    client.init(serverSettings, Nightscout.plugins);
  }
 
  var language = client.language;
  var result = {};
  
  language.languages.forEach( function eachLanguage(l) {
    result[l.code] = { total: 0, ok: 0, missing: 0, keys: [] };
    _.forEach(language.translations, function (n, t) {
      result[l.code].total++;
      if (language.translations[t][l.code]) {
        result[l.code].ok++;
      } else {
        result[l.code].missing++;
        result[l.code].keys.push(t);
      }
    });
  });
  
  var table = $('<table>').append('<tr><th>Language</th><th>Code</th><th>Translated</th><th>Not translated</th><th>Percent</th><th>Missing</th></tr>');
  language.languages.forEach( function eachLanguage(l) {
    if (l.code === 'en') {
      return;
    }
    var tr = $('<tr>');
    tr.append($('<td>').append(l.language));
    tr.append($('<td>').append(l.code));
    tr.append($('<td>').append(result[l.code].ok));
    tr.append($('<td>').append(result[l.code].missing));
    tr.append($('<td>').append((result[l.code].ok / result[l.code].total * 100).toFixed(1) + '%'));
    tr.append($('<td>').attr('width','300px').append(result[l.code].keys.join('<br>')));
    
    table.append(tr);
  });
  
  var placeholder = $('#translations');
  placeholder.html(table);
  
})();