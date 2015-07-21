'use strict';

function init(lang) {
  
  function language() {
    return language;
  }

  var translations = {
    // Client
    'Mo' : {
      cs: 'Po'
      ,de: 'Mo'
      }
    ,'Tu' : {
      cs: 'Út'
      ,de: 'Di'
      },
    ',We' : {
      cs: 'St'
      ,de: 'Mi'
      }
    ,'Th' : {
      cs: 'Čt'
      ,de: 'Do'
      }
    ,'Fr' : {
      cs: 'Pá'
      ,de: 'Fr'
      }
    ,'Sa' : {
      cs: 'So'
      ,de: 'Sa'
      }
    ,'Su' : {
      cs: 'Ne'
      ,de: 'So'
      }
    ,'Monday' : {
      cs: 'Pondělí'
      ,de: 'Montag'
      }
    ,'Tuesday' : {
      cs: 'Úterý'
      ,de: 'Dienstag'
      }
    ,'Wednesday' : {
      cs: 'Středa'
      ,de: 'Mittwoch'
      }
    ,'Thursday' : {
      cs: 'Čtvrtek'
      ,de: 'Donnerstag'
      }
    ,'Friday' : {
      cs: 'Pátek'
      ,de: 'Freitag'
      }
    ,'Saturday' : {
      cs: 'Sobota'
      ,de: 'Samstag'
      }
    ,'Sunday' : {
      cs: 'Neděle'
      ,de: 'Sonntag'
      }
    ,'Category' : {
      cs: 'Kategorie'
      ,de: 'Kategorie'
      }
    ,'Subcategory' : {   
      cs: 'Podkategorie'
      ,de: 'Unterkategorie'
      }
    ,'Name' : {   
      cs: 'Jméno'
      ,de: 'Name'
      }
    ,'Today' : {   
      cs: 'Dnes'
      ,de: 'Heute'
      }
    ,'Last 2 days' : {   
      cs: 'Poslední 2 dny'
      ,de: 'letzte 2 Tage'
      }
    ,'Last 3 days' : {   
      cs: 'Poslední 3 dny'
      ,de: 'letzte 3 Tage'
      }
    ,'Last week' : {   
      cs: 'Poslední týden'
      ,de: 'letzte Woche'
      }
    ,'Last 2 weeks' : {   
      cs: 'Poslední 2 týdny'
      ,de: 'letzte 2 Wochen'
      }
    ,'Last month' : {   
      cs: 'Poslední měsíc'
      ,de: 'letzter Monat'
      }
    ,'Last 3 months' : {   
      cs: 'Poslední 3 měsíce'
      ,de: 'letzte 3 Monate'
      }
    ,'From' : {   
      cs: 'Od'
      ,de: 'Von'
      }
    ,'To' : {   
      cs: 'Do'
      ,de: 'Bis'
      }
    ,'Notes' : {   
      cs: 'Poznámky'
      ,de: 'Notiz'
      }
    ,'Food' : {   
      cs: 'Jídlo'
      ,de: 'Essen'
      }
    ,'Insulin' : {   
      cs: 'Inzulín'
      ,de: 'Insulin'
      }
    ,'Carbs' : {   
      cs: 'Sacharidy'
      ,de: 'Kohlenhydrate'
      }
    ,'Notes contain' : {   
      cs: 'Poznámky obsahují'
      ,de: 'Notizen beinhalten'
      }
    ,'Event type contains' : {   
      cs: 'Typ události obsahuje'
      ,de: 'Ereignis-Typ beinhaltet'
      }
    ,'Target bg range bottom' : {   
      cs: 'Cílová glykémie spodní'
      ,de: 'Untergrenze des Blutzuckerzielbereichs'
      }
    ,'top' : {   
      cs: 'horní'
      ,de: 'oben'
      }
    ,'Show' : {   
      cs: 'Zobraz'
      ,de: 'Zeige'
      }
    ,'Display' : {   
      cs: 'Zobraz'
      ,de: 'Zeige'
      }
    ,'Loading' : {   
      cs: 'Nahrávám'
      ,de: 'Laden'
      }
    ,'Loading profile' : {   
      cs: 'Nahrávám profil'
      ,de: 'Lade Profil'
      }
    ,'Loading status' : {   
      cs: 'Nahrávám status'
      ,de: 'Lade Status'
      }
    ,'Loading food database' : {   
      cs: 'Nahrávám databázi jídel'
      ,de: 'Lade Essensdatenbank'
      }
    ,'not displayed' : {   
      cs: 'není zobrazeno'
      ,de: 'nicht angezeigt'
      }
    ,'Loading CGM data of' : {   
      cs: 'Nahrávám CGM data'
      ,de: 'Lade CGM-Daten von'
      }
    ,'Loading treatments data of' : {   
      cs: 'Nahrávám data ošetření'
      ,de: 'Lade Behandlungsdaten von'
      }
    ,'Processing data of' : {   
      cs: 'Zpracovávám data'
      ,de: 'Verarbeite Daten von'
      }
    ,'Portion' : {   
      cs: 'Porce'
      ,de: 'Portion'
      }
    ,'Size' : {   
      cs: 'Rozměr'
      ,de: 'Größe'
      }
    ,'(none)' : {   
      cs: '(Prázdný)'
      ,de: '(nichts)'
      }
    ,'Result is empty' : {   
      cs: 'Prázdný výsledek'
      ,de: 'Leeres Ergebnis'
      }
// ported reporting
    ,'Day to day' : {   
      cs: 'Den po dni'
      }
    ,'Daily Stats' : {   
      cs: 'Denní statistiky'
      }
    ,'Percentile Chart' : {   
      cs: 'Percentil'
      }
    ,'Distribution' : {   
      cs: 'Rozložení'
      }
    ,'Hourly stats' : {   
      cs: 'Statistika po hodinách'
      }
    ,'Weekly success' : {   
      cs: 'Statistika po týdnech'
      }
    ,'No data available' : {   
      cs: 'Žádná dostupná data'
      }
    ,'Low' : {   
      cs: 'Nízká'
      }
    ,'In Range' : {   
      cs: 'V rozsahu'
      }
    ,'Period' : {   
      cs: 'Období'
      }
    ,'High' : {   
      cs: 'Vysoká'
      }
    ,'Average' : {   
      cs: 'Průměrná'
      }
    ,'Low Quartile' : {   
      cs: 'Nízký kvartil'
      }
    ,'Upper Quartile' : {   
      cs: 'Vysoký kvartil'
      }
    ,'Quartile' : {   
      cs: 'Kvartil'
      }
    ,'Date' : {   
      cs: 'Datum'
      }
    ,'Normal' : {   
      cs: 'Normální'
      }
    ,'Median' : {   
      cs: 'Medián'
      }
    ,'Readings' : {   
      cs: 'Záznamů'
      }
    ,'StDev' : {   
      cs: 'St. odchylka'
      }
    ,'Daily stats report' : {   
      cs: 'Denní statistiky'
      }
    ,'Glucose Percentile report' : {   
      cs: 'Tabulka percentil glykémií'
      }
    ,'Glucose distribution' : {   
      cs: 'Rozložení glykémií'
      }
    ,'days total' : {   
      cs: 'dní celkem'
      }
    ,'Overall' : {   
      cs: 'Celkem'
      }
    ,'Range' : {   
      cs: 'Rozsah'
      }
    ,'% of Readings' : {   
      cs: '% záznamů'
      }
    ,'# of Readings' : {   
      cs: 'počet záznamů'
      }
    ,'Mean' : {   
      cs: 'Střední hodnota'
      }
    ,'Standard Deviation' : {   
      cs: 'Standardní odchylka'
      }
    ,'Max' : {   
      cs: 'Max'
      }
    ,'Min' : {   
      cs: 'Min'
      }
    ,'A1c estimation*' : {   
      cs: 'Předpokládané HBA1c*'
      }
    ,'Weekly Success' : {   
      cs: 'Týdenní úspěšnost'
      }
    ,'There is not sufficient data to run this report. Select more days.' : {   
      cs: 'Není dostatek dat. Vyberte delší časové období.'
      }
// food editor
    ,'Using stored API secret hash' : {   
      cs: 'Používám uložený hash API hesla'
      }
    ,'No API secret hash stored yet. You need to enter API secret.' : {   
      cs: 'Není uložený žádný hash API hesla. Musíte zadat API heslo.'
      }
    ,'Database loaded' : {   
      cs: 'Databáze načtena'
      }
    ,'Error: Database failed to load' : {   
      cs: 'Chyba při načítání databáze'
      }
    ,'Create new record' : {   
      cs: 'Vytvořit nový záznam'
      }
    ,'Save record' : {   
      cs: 'Uložit záznam'
      }
    ,'Portions' : {   
      cs: 'Porcí'
      }
    ,'Unit' : {   
      cs: 'Jedn'
      }
    ,'GI' : {   
      cs: 'GI'
      }
    ,'Edit record' : {   
      cs: 'Upravit záznam'
      }
    ,'Delete record' : {   
      cs: 'Smazat záznam'
      }
    ,'Move to the top' : {   
      cs: 'Přesuň na začátek'
      }
    ,'Hidden' : {   
      cs: 'Skrytý'
      }
    ,'Hide after use' : {   
      cs: 'Skryj po použití'
      }
    ,'Your API secret must be at least 12 characters long' : {   
      cs: 'Vaše API heslo musí mít alespoň 12 znaků'
      }
    ,'Bad API secret' : {   
      cs: 'Chybné API heslo'
      }
    ,'API secret hash stored' : {   
      cs: 'Hash API hesla uložen'
      }
    ,'Status' : {   
      cs: 'Status'
      }
    ,'Not loaded' : {   
      cs: 'Nenačtený'
      }
    ,'Food editor' : {   
      cs: 'Editor jídel'
      }
    ,'Your database' : {   
      cs: 'Vaše databáze'
      }
    ,'Filter' : {   
      cs: 'Filtr'
      }
    ,'Save' : {   
      cs: 'Ulož'
      }
    ,'Clear' : {   
      cs: 'Vymaž'
      }
    ,'Record' : {   
      cs: 'Záznam'
      }
    ,'Quick picks' : {   
      cs: 'Rychlý výběr'
      }
    ,'Show hidden' : {   
      cs: 'Zobraz skryté'
      }
    ,'Your API secret' : {   
      cs: 'Vaše API heslo'
      }
    ,'Store hash on this computer (Use only on private computers)' : {   
      cs: 'Ulož hash na tomto počítači (používejte pouze na soukromých počítačích)'
      }
    ,'Treatments' : {   
      cs: 'Ošetření'
      }
    ,'Time' : {   
      cs: 'Čas'
      }
    ,'Event Type' : {   
      cs: 'Typ události'
      }
    ,'Blood Glucose' : {   
      cs: 'Glykémie'
      }
    ,'Entered By' : {   
      cs: 'Zadal'
      }
    ,'Delete this treatment?' : {   
      cs: 'Vymazat toto ošetření?'
      }
    ,'Carbs Given' : {   
      cs: 'Sacharidů'
      }
    ,'Inzulin Given' : {   
      cs: 'Inzulínu'
      }
    ,'Event Time' : {   
      cs: 'Čas události'
      }
    ,'Please verify that the data entered is correct' : {   
      cs: 'Prosím zkontrolujte, zda jsou údaje zadány správně'
      }
    ,'BG' : {   
      cs: 'Glykémie'
      }
    ,'Use BG correction in calculation' : {   
      cs: 'Použij korekci na glykémii'
      }
    ,'BG from CGM (autoupdated)' : {   
      cs: 'Glykémie z CGM (automaticky aktualizovaná)'
      }
    ,'BG from meter' : {   
      cs: 'Glykémie z glukoměru'
      }
    ,'Manual BG' : {   
      cs: 'Ručně zadaná glykémie'
      }
    ,'Quickpick' : {   
      cs: 'Rychlý výběr'
      }
    ,'or' : {   
      cs: 'nebo'
      }
    ,'Add from database' : {   
      cs: 'Přidat z databáze'
      }
    ,'Use carbs correction in calculation' : {   
      cs: 'Použij korekci na sacharidy'
      }
    ,'Use COB correction in calculation' : {   
      cs: 'Použij korekci na COB'
      }
    ,'Use IOB in calculation' : {   
      cs: 'Použij IOB ve výpočtu'
      }
    ,'Other correction' : {   
      cs: 'Jiná korekce'
      }
    ,'Rounding' : {   
      cs: 'Zaokrouhlení'
      }
    ,'Enter insulin correction in treatment' : {   
      cs: 'Zahrň inzulín do záznamu ošetření'
      }
    ,'Insulin needed' : {   
      cs: 'Potřebný inzulín'
      }
    ,'Carbs needed' : {   
      cs: 'Potřebné sach'
      }
    ,'Carbs needed if Insulin total is negative value' : {   
      cs: 'Chybějící sacharidy v případě, že výsledek je záporný'
      }
    ,'Basal rate' : {   
      cs: 'Bazál'
      }
    ,'Eating' : {   
      cs: 'Jídlo'
      }
    ,'60 minutes before' : {   
      cs: '60 min předem'
      }
    ,'45 minutes before' : {   
      cs: '45 min předem'
      }
    ,'30 minutes before' : {   
      cs: '30 min předem'
      }
    ,'20 minutes before' : {   
      cs: '20 min předem'
      }
    ,'15 minutes before' : {   
      cs: '15 min předem'
      }
    ,'Time in minutes' : {   
      cs: 'Čas v minutách'
      }
    ,'15 minutes after' : {   
      cs: '15 min po'
      }
    ,'20 minutes after' : {   
      cs: '20 min po'
      }
    ,'30 minutes after' : {   
      cs: '30 min po'
      }
    ,'45 minutes after' : {   
      cs: '45 min po'
      }
    ,'60 minutes after' : {   
      cs: '60 min po'
      }
    ,'Additional Notes, Comments:' : {   
      cs: 'Dalši poznámky, komentáře:'
      }
    ,'RETRO MODE' : {   
      cs: 'V MINULOSTI'
      }
    ,'Now' : {   
      cs: 'Nyní'
      }
    ,'Other' : {   
      cs: 'Jiný'
      }
    ,'Submit Form' : {   
      cs: 'Odeslat formulář'
      }
    ,'Profile editor' : {   
      cs: 'Editor profilu'
      }
    ,'Reporting tool' : {   
      cs: 'Výkazy'
      }
    ,'Add food from your database' : {   
      cs: 'Přidat jidlo z Vaší databáze'
      }
    ,'Reload database' : {   
      cs: 'Znovu nahraj databázi'
      }
    ,'Add' : {   
      cs: 'Přidej'
      }
    ,'Unauthorized' : {   
      cs: 'Neautorizováno'
      }
    ,'Entering record failed' : {   
      cs: 'Vložení záznamu selhalo'
      }
    ,'Device authenticated' : {   
      cs: 'Zařízení ověřeno'
      }
    ,'Device not authenticated' : {   
      cs: 'Zařízení není ověřeno'
      }
    ,'Authentication status' : {   
      cs: 'Stav ověření'
      }
    ,'Authenticate' : {   
      cs: 'Ověřit'
      }
    ,'Remove' : {   
      cs: 'Vymazat'
      }
    ,'Your device is not authenticated yet' : {   
      cs: 'Toto zařízení nebylo dosud ověřeno'
      }
    ,'Sensor' : {   
      cs: 'Senzor'
      }
    ,'Finger' : {   
      cs: 'Glukoměr'
      }
    ,'Manual' : {   
      cs: 'Ručně'
      }
    ,'Scale' : {   
      cs: 'Měřítko'
      }
    ,'Linear' : {   
      cs: 'lineární'
      }
    ,'Logarithmic' : {   
      cs: 'logaritmické'
      }
    ,'Silence for 30 minutes' : {   
      cs: 'Ztlumit na 30 minut'
      }
    ,'Silence for 60 minutes' : {   
      cs: 'Ztlumit na 60 minut'
      }
    ,'Silence for 90 minutes' : {   
      cs: 'Ztlumit na 90 minut'
      }
    ,'Silence for 120 minutes' : {   
      cs: 'Ztlumit na 120 minut'
      }
    ,'3HR' : {   
      cs: '3hod'
      }
    ,'6HR' : {   
      cs: '6hod'
      }
    ,'12HR' : {   
      cs: '12hod'
      }
    ,'24HR' : {   
      cs: '24hod'
      }
    ,'Sttings' : {   
      cs: 'Nastavení'
      }
    ,'Units' : {   
      cs: 'Jednotky'
      }
    ,'Date format' : {   
      cs: 'Formát datumu'
      }
    ,'12 hours' : {   
      cs: '12 hodin'
      }
    ,'24 hours' : {   
      cs: '24 hodin'
      }
    ,'Log a Treatment' : {   
      cs: 'Záznam ošetření'
      }
    ,'BG Check' : {   
      cs: 'Kontrola glykémie'
      }
    ,'Meal Bolus' : {   
      cs: 'Bolus na jídlo'
      }
    ,'Snack Bolus' : {   
      cs: 'Bolus na svačinu'
      }
    ,'Correction Bolus' : {   
      cs: 'Bolus na glykémii'
      }
    ,'Carb Correction' : {   
      cs: 'Přídavek sacharidů'
      }
    ,'Note' : {   
      cs: 'Poznámka'
      }
    ,'Question' : {   
      cs: 'Otázka'
      }
    ,'Exercise' : {   
      cs: 'Cvičení'
      }
    ,'Pump Site Change' : {   
      cs: 'Přepíchnutí kanyly'
      }
    ,'Sensor Start' : {   
      cs: 'Spuštění sensoru'
      }
    ,'Sensor Change' : {   
      cs: 'Výměna sensoru'
      }
    ,'Dexcom Sensor Start' : {   
      cs: 'Spuštění sensoru'
      }
    ,'Dexcom Sensor Change' : {   
      cs: 'Výměna sensoru'
      }
    ,'Insulin Cartridge Change' : {   
      cs: 'Výměna inzulínu'
      }
    ,'D.A.D. Alert' : {   
      cs: 'D.A.D. Alert'
      }
    ,'Glucose Reading' : {   
      cs: 'Hodnota glykémie'
      }
    ,'Measurement Method' : {   
      cs: 'Metoda měření'
      }
    ,'Meter' : {   
      cs: 'Glukoměr'
      }
    ,'Insulin Given' : {   
      cs: 'Inzulín'
      }
    ,'Amount in grams' : {   
      cs: 'Množství v gramech'
      }
    ,'Amount in units' : {   
      cs: 'Množství v jednotkách'
      }
    ,'View all treatments' : {   
      cs: 'Zobraz všechny ošetření'
      }
    ,'Enable Alarms' : {   
      cs: 'Povolit alarmy'
      }
    ,'When enabled an alarm may sound.' : {   
      cs: 'Při povoleném alarmu zní zvuk'
      }
    ,'Urgent High Alarm' : {   
      cs: 'Urgentní vysoká glykémie'
      }
    ,'High Alarm' : {   
      cs: 'Vysoká glykémie'
      }
    ,'Low Alarm' : {   
      cs: 'Nízká glykémie'
      }
    ,'Urgent Low Alarm' : {   
      cs: 'Urgentní nízká glykémie'
      }
    ,'Stale Data: Warn' : {   
      cs: 'Zastaralá data'
      }
    ,'Stale Data: Urgent' : {   
      cs: 'Zastaralá data urgentní'
      }
    ,'mins' : {   
      cs: 'min'
      }
    ,'Night Mode' : {   
      cs: 'Noční mód'
      }
    ,'When enabled the page will be dimmed from 10pm - 6am.' : {   
      cs: 'Když je povoleno, obrazovka je ztlumena 22:00 - 6:00'
      }
    ,'Enable' : {   
      cs: 'Povoleno'
      }
    ,'Settings' : {   
      cs: 'Nastavení'
      }
    ,'Show Raw BG Data' : {   
      cs: 'Zobraz RAW data'
      }
    ,'Never' : {   
      cs: 'Nikdy'
      }
    ,'Always' : {   
      cs: 'Vždy'
      }
    ,'When there is noise' : {   
      cs: 'Při šumu'
      }
    ,'When enabled small white dots will be disaplyed for raw BG data' : {   
      cs: 'Když je povoleno, malé tečky budou zobrazeny pro RAW data'
      }
    ,'Custom Title' : {   
      cs: 'Vlastní název stránky'
      }
    ,'Theme' : {   
      cs: 'Téma'
      }
    ,'Default' : {   
      cs: 'Výchozí'
      }
    ,'Colors' : {   
      cs: 'Barevné'
      }
    ,'Reset, and use defaults' : {   
      cs: 'Vymaž a nastav výchozí hodnoty'
      }
    ,'Calibrations' : {   
      cs: 'Kalibrace'
      }
    ,'Alarm Test / Smartphone Enable' : {   
      cs: 'Test alarmu'
      }
    ,'Bolus Wizard' : {   
      cs: 'Bolusový kalkulátor'
      }
    ,'in the future' : {   
      cs: 'v budoucnosti'
      }
    ,'time ago' : {   
      cs: 'min zpět'
      }
    ,'hr ago' : {   
      cs: 'hod zpět'
      }
    ,'hrs ago' : {   
      cs: 'hod zpět'
      }
    ,'min ago' : {   
      cs: 'min zpět'
      }
    ,'mins ago' : {   
      cs: 'min zpět'
      }
    ,'day ago' : {   
      cs: 'den zpět'
      }
    ,'days ago' : {   
      cs: 'dnů zpět'
      }
    ,'long ago' : {   
      cs: 'dlouho zpět'
      }
    ,'Clean' : {   
      cs: 'Čistý'
      }
    ,'Light' : {   
      cs: 'Lehký'
      }
    ,'Medium' : {   
      cs: 'Střední'
      }
    ,'Heavy' : {   
      cs: 'Velký'
      }
    ,'Treatment type' : {   
      cs: 'Typ ošetření'
      }
    ,'Raw BG' : {   
      cs: 'Glykémie z RAW dat'
      }
    ,'Device' : {   
      cs: 'Zařízení'
      }
    ,'Noise' : {   
      cs: 'Šum'
      }
    ,'Calibration' : {   
      cs: 'Kalibrace'
      }
    ,'1' : {   
      cs: '1'
      }
 
 };
  
 language.translate = function translate(text) {
    if (translations[text] && translations[text][lang]) {
      return translations[text][lang];
    }
    return text;
  };
    
  if (typeof window !== 'undefined') {
    // do translation of static text on load
    $('.translate').each(function () {
      $(this).text(language.translate($(this).text()));
    });
    $('.titletranslate').each(function () {
      $(this).attr('title',language.translate($(this).attr('title')));
      $(this).attr('original-title',language.translate($(this).attr('original-title')));
      $(this).attr('placeholder',language.translate($(this).attr('placeholder')));
    });
  }
  return language();
}

module.exports = init;