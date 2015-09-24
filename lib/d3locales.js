'use strict';

// https://github.com/mbostock/d3/wiki/Localization
// https://github.com/mbostock/d3/wiki/Time-Formatting#format
// some are in node_modules/d3/src/locale


var d3locales = { };

d3locales.cs_CZ = {
  decimal: ',',
  thousands: '.',
  grouping: [3],
  currency: ['', 'CZK'],
  dateTime: '%A %e %b %Y %X',
  date: '%d.%m.%Y',
  time: '%H:%M:%S',
  periods: ['AM', 'PM'],
  days: ['Neděle', 'Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota'],
  shortDays: ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'],
  months: ['Leden', 'Únor', 'Březen', 'Duben', 'Květen', 'Červen', 'Červenec', 'Srpen', 'Září', 'Říjen', 'Listopad', 'Prosinec'],
  shortMonths: ['Led', 'Úno', 'Bře', 'Dub', 'Kvě', 'Čvn', 'Čvc', 'Srp', 'Zář', 'Říj', 'Lis', 'Pro']
};

d3locales.en_US = {
  decimal: '.',
  thousands: ',',
  grouping: [3],
  currency: ['$', ''],
  dateTime: '%a %b %e %X %Y',
  date: '%m/%d/%Y',
  time: '%H:%M:%S',
  periods: ['AM', 'PM'],
  days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  shortDays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  shortMonths: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
};

d3locales.es_ES = {
  decimal: ',',
  thousands: '.',
  grouping: [3],
  currency: ['', ' €'],
  dateTime: '%A, %e de %B de %Y, %X',
  date: '%d/%m/%Y',
  time: '%H:%M:%S',
  periods: ['AM', 'PM'],
  days: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
  shortDays: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'],
  months: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
  shortMonths: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
};

d3locales.fr_FR = {
  decimal: ',',
  thousands: '.',
  grouping: [3],
  currency: ['', ' €'],
  dateTime: '%A, le %e %B %Y, %X',
  date: '%d/%m/%Y',
  time: '%H:%M:%S',
  periods: ['AM', 'PM'], // unused
  days: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
  shortDays: ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'],
  months: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
  shortMonths: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']
};

d3locales.he_IL = {
  decimal: '.',
  thousands: ',',
  grouping: [3],
  currency: ['₪', ''],
  dateTime: '%A, %e ב%B %Y %X',
  date: '%d.%m.%Y',
  time: '%H:%M:%S',
  periods: ['AM', 'PM'],
  days: ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'],
  shortDays: ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'],
  months: ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'],
  shortMonths: ['ינו׳', 'פבר׳', 'מרץ', 'אפר׳', 'מאי', 'יוני', 'יולי', 'אוג׳', 'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳']
};

d3locales.it_IT = {
  decimal: ',',
  thousands: '.',
  grouping: [3],
  currency: ['€', ''],
  dateTime: '%A %e %B %Y, %X',
  date: '%d/%m/%Y',
  time: '%H:%M:%S',
  periods: ['AM', 'PM'], // unused
  days: ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'],
  shortDays: ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'],
  months: ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'],
  shortMonths: ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic']
};

d3locales.pt_BR = {
  decimal: ',',
  thousands: '.',
  grouping: [3],
  currency: ['R$', ''],
  dateTime: '%A, %e de %B de %Y. %X',
  date: '%d/%m/%Y',
  time: '%H:%M:%S',
  periods: ['AM', 'PM'],
  days: ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'],
  shortDays: ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'],
  months: ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'],
  shortMonths: ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
};

d3locales.ru_RU = {
  decimal: ',',
  thousands: '\xa0',
  grouping: [3],
  currency: ['', ' руб.'],
  dateTime: '%A, %e %B %Y г. %X',
  date: '%d.%m.%Y',
  time: '%H:%M:%S',
  periods: ['AM', 'PM'],
  days: ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'],
  shortDays: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'],
  months: ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'],
  shortMonths: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
};

d3locales.locale = function locale (language) {
  // map locale until we switch to full en_US
  var mapper = {
      cs: 'cs_CZ'
    , en: 'en_US'
    , es: 'es_ES'
    , fr: 'fr_FR'
    , he: 'he_IL'
    , it: 'it_IT'
    , pt: 'pt_BR'
    , ru: 'ru_RU'
  };
  var loc = 'en_US';
  if (mapper[language]) {
    loc = mapper[language];
  }
  return d3locales[loc];
};

module.exports = d3locales;