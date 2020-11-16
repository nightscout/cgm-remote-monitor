'use strict';

var _ = require('lodash');

function init() {

  function language() {
    return language;
  }

  language.speechCode = 'en-US';
  language.lang = 'en';

  language.languages = [
    { code: 'bg', language: 'Български', speechCode: 'bg-BG' }
    , { code: 'cs', language: 'Čeština', speechCode: 'cs-CZ' }
    , { code: 'de', language: 'Deutsch', speechCode: 'de-DE' }
    , { code: 'dk', language: 'Dansk', speechCode: 'dk-DK' }
    , { code: 'el', language: 'Ελληνικά', speechCode: 'el-GR'}
    , { code: 'en', language: 'English', speechCode: 'en-US' }
    , { code: 'es', language: 'Español', speechCode: 'es-ES' }
    , { code: 'fi', language: 'Suomi', speechCode: 'fi-FI' }
    , { code: 'fr', language: 'Français', speechCode: 'fr-FR' }
    , { code: 'he', language: 'עברית', speechCode: 'he-IL' }
    , { code: 'hr', language: 'Hrvatski', speechCode: 'hr-HR' }
    , { code: 'hu', language: 'Magyar', speechCode: 'hu-HU' }
    , { code: 'it', language: 'Italiano', speechCode: 'it-IT' }
    , { code: 'ja', language: '日本語', speechCode: 'ja-JP' }
    , { code: 'ko', language: '한국어', speechCode: 'ko-KR' }
    , { code: 'nb', language: 'Norsk (Bokmål)', speechCode: 'no-NO' }
    , { code: 'nl', language: 'Nederlands', speechCode: 'nl-NL' }
    , { code: 'pl', language: 'Polski', speechCode: 'pl-PL' }
    , { code: 'pt', language: 'Português (Brasil)', speechCode: 'pt-BR' }
    , { code: 'ro', language: 'Română', speechCode: 'ro-RO' }
    , { code: 'ru', language: 'Русский', speechCode: 'ru-RU' }
    , { code: 'sk', language: 'Slovenčina', speechCode: 'sk-SK' }
    , { code: 'sv', language: 'Svenska', speechCode: 'sv-SE' }
    , { code: 'tr', language: 'Türkçe', speechCode: 'tr-TR' }
    , { code: 'zh_cn', language: '中文（简体）', speechCode: 'cmn-Hans-CN' }
    , { code: 'zh_tw', language: '中文（繁體）', speechCode: 'cmn-Hant-TW' }
  ];

  var translations = {};

  language.translations = translations;

  language.offerTranslations = function offerTranslations(localization) {
    translations = localization;
    language.translations = translations;
  }

  // case sensitive
  language.translateCS = function translateCaseSensitive(text) {
    if (translations[text]) {
      return translations[text];
    }
   // console.log('localization:', text, 'not found');
    return text;
  };

  // case insensitive
  language.translateCI = function translateCaseInsensitive(text) {
    var utext = text.toUpperCase();
    _.forEach(translations, function (ts, key) {
      var ukey = key.toUpperCase();
      if (ukey === utext) {
        text = ts;
      }
    });
    return text;
  };

  language.translate = function translate(text, options) {
    var translated;
    if (options && options.ci) {
      translated = language.translateCI(text);
    } else {
      translated = language.translateCS(text);
    }
    if (options && options.params) {
      for (var i = 0; i < options.params.length; i++) {
        // eslint-disable-next-line no-useless-escape
        var r = new RegExp('\%' + (i+1), 'g');
        translated = translated.replace(r, options.params[i]);
      }
    }
    return translated;
  };

  language.DOMtranslate = function DOMtranslate($) {
    // do translation of static text on load
    $('.translate').each(function () {
      $(this).text(language.translate($(this).text()));
      });
    $('.titletranslate, .tip').each(function () {
      $(this).attr('title',language.translate($(this).attr('title')));
      $(this).attr('original-title',language.translate($(this).attr('original-title')));
      $(this).attr('placeholder',language.translate($(this).attr('placeholder')));
      });
  };

  language.set = function set(newlang) {
    language.lang = newlang;

    language.languages.forEach(function (l) {
      if (l.code === language.lang && l.speechCode) language.speechCode = l.speechCode;
    });

    return language();
  };

  return language();
}

module.exports = init;
