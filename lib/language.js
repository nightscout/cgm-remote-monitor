'use strict';

function init() {
  var lang;
  
  function language() {
    return language;
  }

  var translations = {
    // Server
    'Listening on port' : {
      cs: 'Poslouchám na portu'
      ,es: 'Escuchando en el puerto'
      ,fr: 'Ecoute sur port'
      ,pt: 'Escutando porta'
      ,sv: 'Lyssnar på port'
      ,ro: 'Activ pe portul'
      ,bg: 'Активиране на порта'
      ,hr: 'Slušanje na portu'
      }
    // Client
    ,'Language' : {

    }
    , 'Bulgarian': {

    }
    , 'Croatian': {

    }
    , 'Czech': {

    }
    , 'English': {

    }
    , 'French': {

    }
    , 'German': {

    }
    , 'Portuguese (Brazil)': {

    }
    , 'Romanian': {

    }
    , 'Spanish': {

    }
    , 'Swedish': {

    }
    ,'Mo' : {
      cs: 'Po'
      ,de: 'Mo'
      ,es: 'Lu'
      ,fr: 'Lu'
      ,pt: 'Seg'
      ,sv: 'Mån'
      ,ro: 'Lu'
      ,bg: 'Пон'
      ,hr: 'Pon'
      }
    ,'Tu' : {
      cs: 'Út'
      ,de: 'Di'
      ,es: 'Mar'
      ,fr: 'Ma'
      ,pt: 'Ter'
      ,sv: 'Tis'
      ,ro: 'Ma'
      ,bg: 'Вт'
      ,hr: 'Ut'
      },
    ',We' : {
      cs: 'St'
      ,de: 'Mi'
      ,es: 'Mie'
      ,fr: 'Me'
      ,pt: 'Qua'
      ,sv: 'Ons'
      ,ro: 'Mie'
      ,bg: 'Ср'
      ,hr: 'Sri'
      }
    ,'Th' : {
      cs: 'Čt'
      ,de: 'Do'
      ,es: 'Jue'
      ,fr: 'Je'
      ,pt: 'Qui'
      ,sv: 'Tor'
      ,ro: 'Jo'
      ,bg: 'Четв'
      ,hr: 'Čet'
      }
    ,'Fr' : {
      cs: 'Pá'
      ,de: 'Fr'
      ,es: 'Vie'
      ,fr: 'Ve'
      ,pt: 'Sex'
      ,sv: 'Fre'
      ,ro: 'Vi'
      ,bg: 'Пет'
      ,hr: 'Pet'
      }
    ,'Sa' : {
      cs: 'So'
      ,de: 'Sa'
      ,es: 'Sab'
      ,fr: 'Sa'
      ,pt: 'Sa'
      ,sv: 'Lör'
      ,ro: 'Sa'
      ,bg: 'Съб'
      ,hr: 'Sub'
      }
    ,'Su' : {
      cs: 'Ne'
      ,de: 'So'
      ,es: 'Dom'
      ,fr: 'Di'
      ,pt: 'Dom'
      ,sv: 'Sön'
      ,ro: 'Du'
      ,bg: 'Нед'
      ,hr: 'Ned'
      }
    ,'Monday' : {
      cs: 'Pondělí'
      ,de: 'Montag'
      ,es: 'Lunes'
      ,fr: 'Lundi'
      ,pt: 'Segunda'
      ,sv: 'Måndag'
      ,ro: 'Luni'
      ,bg: 'Понеделник'
      ,hr: 'Ponedjeljak'
      }
    ,'Tuesday' : {
      cs: 'Úterý'
      ,de: 'Dienstag'
      ,es: 'Martes'
      ,fr: 'Mardi'
      ,pt: 'Terça'
      ,ro: 'Marți'
      ,bg: 'Вторник'
      ,hr: 'Utorak'
      ,sv: 'Tisdag'
      }
    ,'Wednesday' : {
      cs: 'Středa'
      ,de: 'Mittwoch'
      ,es: 'Miércoles'
      ,fr: 'Mercredi'
      ,pt: 'Quarta'
      ,sv: 'Onsdag'
      ,ro: 'Miercuri'
      ,bg: 'Сряда'
      ,hr: 'Srijeda'
      }
    ,'Thursday' : {
      cs: 'Čtvrtek'
      ,de: 'Donnerstag'
      ,es: 'Jueves'
      ,fr: 'Jeudi'
      ,pt: 'Quinta'
      ,sv: 'Torsdag'
      ,ro: 'Joi'
      ,bg: 'Четвъртък'
      ,hr: 'Četvrtak'
      }
    ,'Friday' : {
      cs: 'Pátek'
      ,de: 'Freitag'
      ,fr: 'Vendredi'
      ,pt: 'Sexta'
      ,sv: 'Fredag'
      ,ro: 'Vineri'
      ,es: 'Viernes'
      ,bg: 'Петък'
      ,hr: 'Petak'
      }
    ,'Saturday' : {
      cs: 'Sobota'
      ,de: 'Samstag'
      ,es: 'Sábado'
      ,fr: 'Samedi'
      ,pt: 'Sábado'
      ,ro: 'Sâmbătă'
      ,bg: 'Събота'
      ,hr: 'Subota'
      ,sv: 'Lördag'
      }
    ,'Sunday' : {
      cs: 'Neděle'
      ,de: 'Sonntag'
      ,es: 'Domingo'
      ,fr: 'Dimanche'
      ,pt: 'Domingo'
      ,ro: 'Duminică'
      ,bg: 'Неделя'
      ,hr: 'Nedjelja'
      ,sv: 'Söndag'
      }
    ,'Category' : {
      cs: 'Kategorie'
      ,de: 'Kategorie'
      ,es: 'Categoría'
      ,fr: 'Catégorie'
      ,pt: 'Categoria'
      ,sv: 'Kategori'
      ,ro: 'Categorie'
      ,bg: 'Категория'
      ,hr: 'Kategorija'
      }
    ,'Subcategory' : {   
      cs: 'Podkategorie'
      ,de: 'Unterkategorie'
      ,es: 'Subcategoría'
      ,fr: 'Sous-catégorie'
      ,pt: 'Subcategoria'
      ,sv: 'Underkategori'
      ,ro: 'Subcategorie'
      ,bg: 'Подкатегория'
      ,hr: 'Podkategorija'
      }
    ,'Name' : {   
      cs: 'Jméno'
      ,de: 'Name'
      ,es: 'Nombre'
      ,fr: 'Nom'
      ,pt: 'Nome'
      ,sv: 'Namn'
      ,ro: 'Nume'
      ,bg: 'Име'
      ,hr: 'Ime'
      }
    ,'Today' : {   
      cs: 'Dnes'
      ,de: 'Heute'
      ,es: 'Hoy'
      ,fr: 'Aujourd\'hui'
      ,pt: 'Hoje'
      ,ro: 'Astăzi'
      ,bg: 'Днес'
      ,hr: 'Danas'
      ,sv: 'Idag'
      }
    ,'Last 2 days' : {   
      cs: 'Poslední 2 dny'
      ,de: 'letzten 2 Tage'
      ,es: 'Últimos 2 días'
      ,fr: '2 derniers jours'
      ,pt: 'Últimos 2 dias'
      ,ro: 'Ultimele 2 zile'
      ,bg: 'Последните 2 дни'
      ,hr: 'Posljednja 2 dana'
      ,sv: 'Senaste 2 dagarna'
      }
    ,'Last 3 days' : {   
      cs: 'Poslední 3 dny'
      ,de: 'letzten 3 Tage'
      ,es: 'Últimos 3 días'
      ,fr: '3 derniers jours'
      ,pt: 'Últimos 3 dias'
      ,sv: 'Senaste 3 dagarna'
      ,ro: 'Ultimele 3 zile'
      ,bg: 'Последните 3 дни'
      ,hr: 'Posljednja 3 dana'
      }
    ,'Last week' : {   
      cs: 'Poslední týden'
      ,de: 'letzte Woche'
      ,es: 'Semana pasada'
      ,fr: 'Semaine Dernière'
      ,pt: 'Semana passada'
      ,ro: 'Săptămâna trecută'
      ,bg: 'Последната седмица'
      ,hr: 'Protekli tjedan'
      ,sv: 'Senaste veckan'
      }
    ,'Last 2 weeks' : {   
      cs: 'Poslední 2 týdny'
      ,de: 'letzten 2 Wochen'
      ,es: 'Últimas 2 semanas'
      ,fr: '2 dernières semaines'
      ,pt: 'Últimas 2 semanas'
      ,ro: 'Ultimele 2 săptămâni'
      ,bg: 'Последните 2 седмици'
      ,hr: 'Protekla 2 tjedna'
      ,sv: 'Senaste 2 veckorna'
      }
    ,'Last month' : {   
      cs: 'Poslední měsíc'
      ,de: 'letzter Monat'
      ,es: 'Mes pasado'
      ,fr: 'Mois dernier'
      ,pt: 'Mês passado'
      ,ro: 'Ultima lună'
      ,bg: 'Последният месец'
      ,hr: 'Protekli mjesec'
      ,sv: 'Senaste månaden'
      }
    ,'Last 3 months' : {   
      cs: 'Poslední 3 měsíce'
      ,de: 'letzten 3 Monate'
      ,es: 'Últimos 3 meses'
      ,fr: '3 derniers mois'
      ,pt: 'Últimos 3 meses'
      ,ro: 'Ultimele 3 luni'
      ,bg: 'Последните 3 месеца'
      ,hr: 'Protekla 3 mjeseca'
      ,sv: 'Senaste 3 månaderna'
      }
    ,'From' : {   
      cs: 'Od'
      ,de: 'Von'
      ,es: 'Desde'
      ,fr: 'De'
      ,pt: 'De'
      ,sv: 'Från'
      ,ro: 'De la'
      ,bg: 'От'
      ,hr: 'Od'
      }
    ,'To' : {   
      cs: 'Do'
      ,de: 'Bis'
      ,es: 'Hasta'
      ,fr: 'À'
      ,pt: 'Para'
      ,ro: 'La'
      ,bg: 'До'
      ,hr: 'Do'
      ,sv: 'Till'
      }
    ,'Notes' : {   
      cs: 'Poznámky'
      ,de: 'Notiz'
      ,es: 'Notas'
      ,fr: 'Notes'
      ,pt: 'Notas'
      ,sv: 'Notering'
      ,ro: 'Note'
      ,bg: 'Бележки'
      ,hr: 'Bilješke'
      }
    ,'Food' : {   
      cs: 'Jídlo'
      ,de: 'Essen'
      ,es: 'Comida'
      ,fr: 'Nourriture'
      ,pt: 'Comida'
      ,sv: 'Föda'
      ,ro: 'Mâncare'
      ,bg: 'Храна'
      ,hr: 'Hrana'
      }
    ,'Insulin' : {   
      cs: 'Inzulín'
      ,de: 'Insulin'
      ,es: 'Insulina'
      ,fr: 'Insuline'
      ,pt: 'Insulina'
      ,ro: 'Insulină'
      ,bg: 'Инсулин'
      ,hr: 'Inzulin'
      ,sv: 'Insulin'
      }
    ,'Carbs' : {   
      cs: 'Sacharidy'
      ,de: 'Kohlenhydrate'
      ,es: 'Hidratos de carbono'
      ,fr: 'Glucides'
      ,pt: 'Carboidrato'
      ,ro: 'Carbohidrați'
      ,bg: 'Въглехидрати'
      ,hr: 'Ugljikohidrati'
      ,sv: 'Kolhydrater'
      }
    ,'Notes contain' : {   
      cs: 'Poznámky obsahují'
      ,de: 'Erläuterungen'
      ,es: 'Contenido de las notas'
      ,fr: 'Notes contiennent'
      ,pt: 'Notas contém'
      ,ro: 'Conținut note'
      ,bg: 'бележките съдържат'
      ,hr: 'Sadržaj bilješki'
      ,sv: 'Notering innehåller'
      }
    ,'Event type contains' : {   
      cs: 'Typ události obsahuje'
      ,de: 'Ereignis-Typ beinhaltet'
      ,es: 'Contenido del tipo de evento'
      ,fr: 'Type d\'événement contient'
      ,pt: 'Tipo de evento contém'
      ,ro: 'Conținut tip de eveniment'
      ,bg: 'Типа събитие включва'
      ,hr: 'Sadržaj vrste događaja'
      ,sv: 'Händelsen innehåller'
      }
    ,'Target bg range bottom' : {   
      cs: 'Cílová glykémie spodní'
      ,de: 'Untergrenze des Blutzuckerzielbereiches'
      ,es: 'Objetivo inferior de glucemia'
      ,fr: 'Limite inférieure glycémie'
      ,pt: 'Limite inferior de glicemia'
      ,ro: 'Limită de jos a glicemiei'
      ,bg: 'Долна граница на КЗ'
      ,hr: 'Ciljna donja granica GUK-a'
      ,sv: 'Gräns för nedre blodsockervärde'
      }
    ,'top' : {   
      cs: 'horní'
      ,de: 'oben'
      ,es: 'Superior'
      ,fr: 'Supérieur'
      ,pt: 'Superior'
      ,ro: 'Sus'
      ,bg: 'горе'
      ,hr: 'Gornja'
      ,sv: 'Toppen'
      }
    ,'Show' : {   
      cs: 'Zobraz'
      ,de: 'Zeigen'
      ,es: 'Mostrar'
      ,fr: 'Montrer'
      ,pt: 'Mostrar'
      ,ro: 'Arată'
      ,bg: 'Покажи'
      ,hr: 'Prikaži'
      }
    ,'Display' : {   
      cs: 'Zobraz'
      ,de: 'Darstellen'
      ,es: 'Visualizar'
      ,fr: 'Afficher'
      ,pt: 'Mostrar'
      ,ro: 'Afișează'
      ,bg: 'Покажи'
      ,hr: 'Prikaži'
      ,sv: 'Visa'
      }
    ,'Loading' : {   
      cs: 'Nahrávám'
      ,de: 'Laden'
      ,es: 'Cargando'
      ,fr: 'Chargement'
      ,pt: 'Carregando'
      ,ro: 'Se încarcă'
      ,bg: 'Зареждане'
      ,hr: 'Učitavanje'
      ,sv: 'Laddar'
      }
    ,'Loading profile' : {   
      cs: 'Nahrávám profil'
      ,de: 'Lade Profil'
      ,es: 'Cargando perfil'
      ,fr: 'Chargement du profil'
      ,pt: 'Carregando perfil'
      ,sv: 'Laddar profil'
      ,ro: 'Încarc profilul'
      ,bg: 'Зареждане на профил'
      ,hr: 'Učitavanje profila'
      }
    ,'Loading status' : {   
      cs: 'Nahrávám status'
      ,de: 'Lade Status'
      ,es: 'Cargando estado'
      ,fr: 'Statut du chargement'
      ,pt: 'Carregando status'
      ,sv: 'Laddar status'
      ,ro: 'Încarc statusul'
      ,bg: 'Зареждане на статус'
      ,hr: 'Učitavanje statusa'
      }
    ,'Loading food database' : {   
      cs: 'Nahrávám databázi jídel'
      ,de: 'Lade Nahrungsmittel-Datenbank'
      ,es: 'Cargando base de datos de alimentos'
      ,fr: 'Chargement de la base de données alimentaire'
      ,pt: 'Carregando dados de alimentos'
      ,sv: 'Laddar födoämnesdatabas'
      ,ro: 'Încarc baza de date de alimente'
      ,bg: 'Зареждане на данни за храни'
      ,hr: 'Učitavanje baze podataka o hrani'
      }
    ,'not displayed' : {   
      cs: 'není zobrazeno'
      ,de: 'nicht angezeigt'
      ,es: 'No mostrado'
      ,fr: 'non affiché'
      ,pt: 'não mostrado'
      ,ro: 'neafișat'
      ,bg: 'Не се показва'
      ,hr: 'Ne prikazuje se'
      ,sv: 'Visas ej'
      }
    ,'Loading CGM data of' : {   
      cs: 'Nahrávám CGM data'
      ,de: 'Lade CGM-Daten von'
      ,es: 'Cargando datos de CGM de'
      ,fr: 'Chargement données CGM de'
      ,pt: 'Carregando dados de CGM de'
      ,sv: 'Laddar CGM-data för'
      ,ro: 'Încarc datele CGM ale lui'
      ,bg: 'Зареждане на CGM данни от'
      ,hr: 'Učitavanja podataka CGM-a'
      }
    ,'Loading treatments data of' : {   
      cs: 'Nahrávám data ošetření'
      ,de: 'Lade Behandlungsdaten von'
      ,es: 'Cargando datos de tratamientos de'
      ,fr: 'Chargement données traitement de'
      ,pt: 'Carregando dados de tratamento de'
      ,sv: 'Laddar behandlingsdata för'
      ,ro: 'Încarc datele despre tratament pentru'
      ,bg: 'Зареждане на въведените лечения от'
      ,hr: 'Učitavanje podataka o tretmanu'
      }
    ,'Processing data of' : {   
      cs: 'Zpracovávám data'
      ,de: 'Verarbeite Daten von'
      ,es: 'Procesando datos de'
      ,fr: 'Traitement des données de'
      ,pt: 'Processando dados de'
      ,sv: 'Behandlar data för'
      ,ro: 'Procesez datele lui'
      ,bg: 'Зареждане на данни от'
      ,hr: 'Obrada podataka'
      }
    ,'Portion' : {   
      cs: 'Porce'
      ,de: 'Portion'
      ,es: 'Porción'
      ,fr: 'Portion'
      ,pt: 'Porção'
      ,ro: 'Porție'
      ,bg: 'Порция'
      ,hr: 'Dio'
      ,sv: 'Portion'
      }
    ,'Size' : {   
      cs: 'Rozměr'
      ,de: 'Größe'
      ,es: 'Tamaño'
      ,fr: 'Taille'
      ,pt: 'Tamanho'
      ,ro: 'Mărime'
      ,bg: 'Големина'
      ,hr: 'Veličina'
      }
    ,'(none)' : {   
      cs: '(Prázdný)'
      ,de: '(nichts)'
      ,es: '(ninguno)'
      ,fr: '(aucun)'
      ,pt: '(nenhum)'
      ,ro: '(fără)'
      ,bg: 'няма'
      ,hr: '(Prazno)'
      }
    ,'Result is empty' : {   
      cs: 'Prázdný výsledek'
      ,de: 'Leeres Ergebnis'
      ,es: 'Resultado vacío'
      ,fr: 'Pas de résultat'
      ,pt: 'Resultado vazio'
      ,ro: 'Fără rezultat'
      ,bg: 'Няма резултат'
      ,hr: 'Prazan rezultat'
      }
// ported reporting
    ,'Day to day' : {   
      cs: 'Den po dni'
      ,de: 'Von Tag zu Tag'
      ,es: 'Día a día'
      ,fr: 'jour par jour'
      ,pt: 'Dia a dia'
      ,sv: 'Dag för dag'
      ,ro: 'Zi cu zi'
      ,bg: 'Ден за ден'
      ,hr: 'Svakodnevno'
      }
    ,'Daily Stats' : {   
      cs: 'Denní statistiky'
      ,de: 'Tägliche Statistik'
      ,es: 'Estadísticas diarias'
      ,fr: 'Stats quotidiennes'
      ,pt: 'Estatísticas diárias'
      ,sv: 'Dygnsstatistik'
      ,ro: 'Statistici zilnice'
      ,bg: 'Дневна статистика'
      ,hr: 'Dnevna statistika'
      }
    ,'Percentile Chart' : {   
      cs: 'Percentil'
      ,de: 'Durchschnittswert'
      ,es: 'Percentiles'
      ,fr: 'Percentiles'
      ,pt: 'Percentis'
      ,ro: 'Grafic percentile'
      ,bg: 'Процентна графика'
      ,hr: 'Tablica u postotcima'
      ,sv: 'Procentgraf'
      }
    ,'Distribution' : {   
      cs: 'Rozložení'
      ,de: 'Streuung'
      ,es: 'Distribución'
      ,fr: 'Distribution'
      ,pt: 'Distribuição'
      ,ro: 'Distribuție'
      ,bg: 'Разпределение'
      ,hr: 'Distribucija'
      ,sv: 'Distribution'
	  }
    ,'Hourly stats' : {   
      cs: 'Statistika po hodinách'
      ,de: 'Stündliche Statistik'
      ,es: 'Estadísticas por hora'
      ,fr: 'Statistiques horaires'
      ,pt: 'Estatísticas por hora'
      ,sv: 'Timmstatistik'
      ,ro: 'Statistici orare'
      ,bg: 'Статистика по часове'
      ,hr: 'Statistika po satu'
	  }
    ,'Weekly success' : {   
      cs: 'Statistika po týdnech'
      ,de: 'Wöchentlicher Erfolg'
      ,es: 'Resultados semanales'
      ,fr: 'Résultat hebdomadaire'
      ,pt: 'Resultados semanais'
      ,ro: 'Rezultate săptămânale'
      ,bg: 'Седмичен успех'
      ,hr: 'Tjedni uspjeh'
      ,sv: 'Veckoresultat'
      }
    ,'No data available' : {   
      cs: 'Žádná dostupná data'
      ,de: 'Keine Daten verfügbar'
      ,es: 'No hay datos disponibles'
      ,fr: 'Pas de données disponibles'
      ,pt: 'não há dados'
      ,ro: 'Fără date'
      ,bg: 'Няма данни за показване'
      ,hr: 'Nema raspoloživih podataka'
      ,sv: 'Data saknas'
      }
    ,'Low' : {   
      cs: 'Nízká'
      ,de: 'Tief'
      ,es: 'Bajo'
      ,fr: 'Bas'
      ,pt: 'Baixo'
      ,sv: 'Låg'
      ,ro: 'Prea jos'
      ,bg: 'Ниска'
      ,hr: 'Nizak'
      }
    ,'In Range' : {   
      cs: 'V rozsahu'
      ,de: 'Im Zielbereich'
      ,es: 'En rango'
      ,fr: 'dans la norme'
      ,pt: 'Na meta'
      ,sv: 'Inom intervallet'
      ,ro: 'În interval'
      ,bg: 'В граници'
      ,hr: 'U rasponu'
      }
    ,'Period' : {   
      cs: 'Období'
      ,de: 'Zeitraum'
      ,es: 'Periodo'
      ,fr: 'Période'
      ,pt: 'Período'
      ,sv: 'Period'
      ,ro: 'Perioada'
      ,bg: 'Период'
      ,hr: 'Period'
      }
    ,'High' : {   
      cs: 'Vysoká'
      ,de: 'Hoch'
      ,es: 'Alto'
      ,fr: 'Haut'
      ,pt: 'Alto'
      ,sv: 'Hög'
      ,ro: 'Prea sus'
      ,bg: 'Висока'
      ,hr: 'Visok'
      }
    ,'Average' : {   
      cs: 'Průměrná'
      ,de: 'Mittelwert'
      ,es: 'Media'
      ,fr: 'Moyenne'
      ,pt: 'Média'
      ,sv: 'Genomsnittligt'
      ,ro: 'Media'
      ,bg: 'Средна'
      ,hr: 'Prosjek'
      }
    ,'Low Quartile' : {   
      cs: 'Nízký kvartil'
      ,de: 'Unteres Quartil'
      ,es: 'Cuartil inferior'
      ,fr: 'Quartile inférieur'
      ,pt: 'Quartil inferior'
      ,ro: 'Pătrime inferioară'
      ,bg: 'Ниска четвъртинка'
      ,hr: 'Donji kvartil'
      ,sv: 'Nedre kvadranten'
      }
    ,'Upper Quartile' : {   
      cs: 'Vysoký kvartil'
      ,de: 'Oberes Quartil'
      ,es: 'Cuartil superior'
      ,fr: 'Quartile supérieur'
      ,pt: 'Quartil superior'
      ,ro: 'Pătrime superioară'
      ,bg: 'Висока четвъртинка'
      ,hr: 'Gornji kvartil'
      ,sv: 'Övre kvadranten'
      }
    ,'Quartile' : {   
      cs: 'Kvartil'
      ,de: 'Quartil'
      ,es: 'Cuartil'
      ,fr: 'Quartile'
      ,pt: 'Quartil'
      ,ro: 'Pătrime'
      ,bg: 'Четвъртинка'
      ,hr: 'Kvartil'
      }
    ,'Date' : {   
      cs: 'Datum'
      ,de: 'Datum'
      ,es: 'Fecha'
      ,fr: 'Date'
      ,pt: 'Data'
      ,sv: 'Datum'
      ,ro: 'Data'
      ,bg: 'Дата'
      ,hr: 'Datum'
      }
    ,'Normal' : {   
      cs: 'Normální'
      ,de: 'Normal'
      ,es: 'Normal'
      ,fr: 'Normale'
      ,pt: 'Normal'
      ,sv: 'Normal'
      ,ro: 'Normal'
      ,bg: 'Нормално'
      ,hr: 'Normalno'
      }
    ,'Median' : {   
      cs: 'Medián'
      ,de: 'Median'
      ,es: 'Mediana'
      ,fr: 'Médiane'
      ,pt: 'Mediana'
      ,ro: 'Mediană'
      ,bg: 'Средно'
      ,hr: 'Srednje'
      ,sv: 'Median'
      }
    ,'Readings' : {   
      cs: 'Záznamů'
      ,de: 'Messwerte'
      ,es: 'Valores'
      ,fr: 'Valeurs'
      ,pt: 'Valores'
      ,sv: 'Avläsning'
      ,ro: 'Valori'
      ,bg: 'Измервания'
      ,hr: 'Vrijednosti'
      }
    ,'StDev' : {   
      cs: 'St. odchylka'
      ,de: 'Standardabweichung'
      ,es: 'Desviación estándar'
      ,fr: 'Déviation St.'
      ,pt: 'DesvPadr'
      ,sv: 'StdDev'
      ,ro: 'Dev Std'
      ,bg: 'Стандартно отклонение'
      ,hr: 'Standardna devijacija'
      }
    ,'Daily stats report' : {   
      cs: 'Denní statistiky'
      ,de: 'Tagesstatistik Bericht'
      ,es: 'Informe de estadísticas diarias'
      ,fr: 'Rapport quotidien'
      ,pt: 'Relatório diário'
      ,ro: 'Raport statistică zilnică'
      ,bg: 'Дневна статистика'
      ,hr: 'Izvješće o dnevnim statistikama'
      ,sv: 'Dygnsstatistik'
      }
    ,'Glucose Percentile report' : {   
      cs: 'Tabulka percentil glykémií'
      ,de: 'Glukose-Prozent Bericht'
      ,es: 'Informe de percetiles de glucemia'
      ,fr: 'Rapport percentiles Glycémie'
      ,pt: 'Relatório de Percentis de Glicemia'
      ,sv: 'Glukosrapport i procent'
      ,ro: 'Raport percentile glicemii'
      ,bg: 'Графика на КЗ'
      ,hr: 'Izvješće o postotku GUK-a'
      }
    ,'Glucose distribution' : {   
      cs: 'Rozložení glykémií'
      ,de: 'Glukuse Verteilung'
      ,es: 'Distribución de glucemias'
      ,fr: 'Distribution glycémies'
      ,pt: 'Distribuição de glicemias'
      ,ro: 'Distribuție glicemie'
      ,bg: 'Разпределение на КЗ'
      ,hr: 'Distribucija GUK-a'
      ,sv: 'Glukosdistribution'
      }
    ,'days total' : {   
      cs: 'dní celkem'
      ,de: 'Gesamttage'
      ,es: 'Total de días'
      ,fr: 'jours totaux'
      ,pt: 'dias total'
      ,sv: 'antal dagar'
      ,ro: 'total zile'
      ,bg: 'общо за деня'
      ,hr: 'ukupno dana'
      }
    ,'Overall' : {   
      cs: 'Celkem'
      ,de: 'Insgesamt'
      ,es: 'General'
      ,fr: 'En général'
      ,pt: 'Geral'
      ,sv: 'Genomsnitt'
      ,ro: 'General'
      ,bg: 'Общо'
      ,hr: 'Ukupno'
      }
    ,'Range' : {   
      cs: 'Rozsah'
      ,de: 'Bereich'
      ,es: 'Intervalo'
      ,fr: 'Intervalle'
      ,pt: 'intervalo'
      ,sv: 'Intervall'
      ,ro: 'Interval'
      ,bg: 'Диапазон'
      ,hr: 'Raspon'
      }
    ,'% of Readings' : {   
      cs: '% záznamů'
      ,de: '% der Messwerte'
      ,es: '% de valores'
      ,fr: '% de valeurs'
      ,pt: '% de valores'
      ,sv: '& av avläsningar'
      ,ro: '% de valori'
      ,bg: '% от измервания'
      ,hr: '% očitanja'
      }
    ,'# of Readings' : {   
      cs: 'počet záznamů'
      ,de: '# der Messwerte'
      ,es: 'N° de valores'
      ,fr: 'nbr de valeurs'
      ,pt: 'N° de valores'
      ,sv: 'av avläsningar'
      ,ro: 'nr. de valori'
      ,bg: '№ от измервания'
      ,hr: 'broj očitanja'
      }
    ,'Mean' : {   
      cs: 'Střední hodnota'
      ,de: 'Durchschnittlich'
      ,es: 'Media'
      ,fr: 'Moyenne'
      ,pt: 'Média'
      ,sv: 'Genomsnitt'
      ,ro: 'Medie'
      ,bg: 'Средна стойност'
      ,hr: 'Prosjek'
      }
    ,'Standard Deviation' : {   
      cs: 'Standardní odchylka'
      ,de: 'Standardabweichung'
      ,es: 'Desviación estándar'
      ,fr: 'Déviation Standard'
      ,pt: 'Desvio padrão'
      ,ro: 'Deviație standard'
      ,bg: 'Стандартно отклонение'
      ,hr: 'Standardna devijacija'
      ,sv: 'Standardavvikelse'
      }
    ,'Max' : {   
      cs: 'Max'
      ,de: 'Max'
      ,es: 'Max'
      ,fr: 'Max'
      ,pt: 'Max'
      ,sv: 'Max'
      ,ro: 'Max'
      ,bg: 'Максимално'
      ,hr: 'Max'
      }
    ,'Min' : {   
      cs: 'Min'
      ,de: 'Min'
      ,es: 'Min'
      ,fr: 'Min'
      ,pt: 'Min'
      ,sv: 'Min'
      ,ro: 'Min'
      ,bg: 'Минимално'
      ,hr: 'Min'
      }
    ,'A1c estimation*' : {   
      cs: 'Předpokládané HBA1c*'
      ,de: 'Prognose HbA1c*'
      ,es: 'Estimación de HbA1c*'
      ,fr: 'Estimation HbA1c*'
      ,pt: 'A1c estimada'
      ,ro: 'HbA1C estimată'
      ,bg: 'Очакван HbA1c'
      ,hr: 'Procjena HbA1c-a'
      ,sv: 'Beräknat A1c-värde '
      }
    ,'Weekly Success' : {   
      cs: 'Týdenní úspěšnost'
      ,de: 'Wöchtlicher Erfolg'
      ,es: 'Resultados semanales'
      ,fr: 'Réussite hebdomadaire'
      ,pt: 'Resultados semanais'
      ,ro: 'Rezultate săptămânale'
      ,bg: 'Седмичен успех'
      ,hr: 'Tjedni uspjeh'
      ,sv: 'Veckoresultat'
      }
    ,'There is not sufficient data to run this report. Select more days.' : {   
      cs: 'Není dostatek dat. Vyberte delší časové období.'
      ,de: 'Für diesen Bericht sind nicht genug Daten verfügbar. Bitte weitere Tage auswählen'
      ,es: 'No hay datos suficientes para generar este informe. Seleccione más días.'
      ,fr: 'Pas assez de données pour un rapport. Sélectionnez plus de jours.'
      ,pt: 'Não há dados suficientes. Selecione mais dias'
      ,ro: 'Nu sunt sufieciente date pentru acest raport. Selectați mai multe zile.'
      ,bg: 'Няма достатъчно данни за показване. Изберете повече дни.'
      ,hr: 'Nema dovoljno podataka za izvođenje izvještaja. Odaberite još dana.'
      ,sv: 'Data saknas för att köra rapport. Välj fler dagar.'
	  }
// food editor
    ,'Using stored API secret hash' : {   
      cs: 'Používám uložený hash API hesla'
      ,de: 'Gespeicherte API-Prüfsumme verwenden'
      ,es: 'Usando el hash del API pre-almacenado'
      ,fr: 'Utilisation du hash API existant'
      ,pt: 'Usando o hash de API existente'
      ,ro: 'Utilizez cheie API secretă'
      ,bg: 'Използване на запаметена API парола'
      ,hr: 'Koristi se pohranjeni API tajni hash'
      ,sv: 'Använd hemlig API-nyckel'
      }
    ,'No API secret hash stored yet. You need to enter API secret.' : {   
      cs: 'Není uložený žádný hash API hesla. Musíte zadat API heslo.'
      ,de: 'Keine API-Prüfsumme gespeichert. Bitte API-Prüfsumme eingeben.'
      ,es: 'No se ha almacenado ningún hash todavía. Debe introducir su secreto API.'
      ,fr: 'Pas de secret API existant. Vous devez l\'en entrer.'
      ,pt: 'Hash de segredo de API inexistente. Entre um segredo de API'
      ,ro: 'Încă nu există cheie API secretă. Aceasta trebuie introdusă.'
      ,bg: 'Няма запаметена API парола. Tрябва да въведете API парола'
      ,hr: 'Nema pohranjenog API tajnog hasha. Unesite tajni API'
      ,sv: 'Hemlig api-nyckel saknas. Du måste ange API hemlighet'
    }
    ,'Database loaded' : {   
      cs: 'Databáze načtena'
      ,de: 'Datenbank geladen'
      ,es: 'Base de datos cargada'
      ,fr: 'Base de données chargée'
      ,pt: 'Banco de dados carregado'
      ,ro: 'Baza de date încărcată'
      ,bg: 'База с данни заредена'
      ,hr: 'Baza podataka je učitana'
      ,sv: 'Databas laddad'
      }
    ,'Error: Database failed to load' : {   
      cs: 'Chyba při načítání databáze'
      ,de: 'Fehler: Datenbank konnte nicht geladen werden'
      ,es: 'Error: Carga de base de datos fallida'
      ,fr: 'Erreur: le chargement de la base de données a échoué'
      ,pt: 'Erro: Banco de dados não carregado'
      ,ro: 'Eroare: Nu s-a încărcat baza de date'
      ,bg: 'ГРЕШКА. Базата с данни не успя да се зареди'
      ,hr: 'Greška: Baza podataka nije učitana'
      ,sv: 'Error: Databas kan ej laddas'
      }
    ,'Create new record' : {   
      cs: 'Vytvořit nový záznam'
      ,de: 'Erstelle neuen Datensatz'
      ,es: 'Crear nuevo registro'
      ,fr: 'Créer nouvel enregistrement'
      ,pt: 'Criar novo registro'
      ,ro: 'Crează înregistrare nouă'
      ,bg: 'Създаване на нов запис'
      ,hr: 'Kreiraj novi zapis'
      ,sv: 'Skapa ny post'
      }
    ,'Save record' : {   
      cs: 'Uložit záznam'
      ,de: 'Speichere Datensatz'
      ,es: 'Guardar registro'
      ,fr: 'Sauver enregistrement'
      ,pt: 'Salvar registro'
      ,ro: 'Salvează înregistrarea'
      ,bg: 'Запази запис'
      ,hr: 'Spremi zapis'
      ,sv: 'Spara post'
      }
    ,'Portions' : {   
      cs: 'Porcí'
      ,de: 'Portionen'
      ,es: 'Porciones'
      ,fr: 'Portions'
      ,pt: 'Porções'
      ,ro: 'Porții'
      ,bg: 'Порции'
      ,hr: 'Dijelovi'
      ,sv: 'Portion'
      }
    ,'Unit' : {   
      cs: 'Jedn'
      ,de: 'Einheit'
      ,es: 'Unidades'
      ,fr: 'Unités'
      ,pt: 'Unidade'
      ,ro: 'Unități'
      ,bg: 'Единици'
      ,hr: 'Jedinica'
      ,sv: 'Enhet'
      }
    ,'GI' : {   
      cs: 'GI'
      ,de: 'GI'
      ,es: 'IG'
      ,fr: 'IG'
      ,pt: 'IG'
      ,sv: 'GI'
      ,ro: 'CI'
      ,bg: 'ГИ'
      ,hr: 'GI'
      }
    ,'Edit record' : {   
      cs: 'Upravit záznam'
      ,de: 'Bearbeite Datensatz'
      ,es: 'Editar registro'
      ,fr: 'Modifier enregistrement'
      ,pt: 'Editar registro'
      ,ro: 'Editează înregistrarea'
      ,bg: 'Редактирай запис'
      ,hr: 'Uredi zapis'
      ,sv: 'Editera post'
      }
    ,'Delete record' : {   
      cs: 'Smazat záznam'
      ,de: 'Lösche Datensatz'
      ,es: 'Borrar registro'
      ,fr: 'Effacer enregistrement'
      ,pt: 'Apagar registro'
      ,ro: 'Șterge înregistrarea'
      ,bg: 'Изтрий запис'
      ,hr: 'Izbriši zapis'
      ,sv: 'Ta bort post'
      }
    ,'Move to the top' : {   
      cs: 'Přesuň na začátek'
      ,de: 'Gehe zum Anfang'
      ,es: 'Mover arriba'
      ,fr: 'Déplacer au sommet'
      ,pt: 'Mover para o topo'
      ,sv: 'Gå till toppen'
      ,ro: 'Mergi la început'
      ,bg: 'Преместване в началото'
      ,hr: 'Premjesti na vrh'
      }
    ,'Hidden' : {   
      cs: 'Skrytý'
      ,de: 'Versteckt'
      ,es: 'Oculto'
      ,fr: 'Caché'
      ,pt: 'Oculto'
      ,sv: 'Dold'
      ,ro: 'Ascuns'
      ,bg: 'Скрити'
      ,hr: 'Skriveno'
      }
    ,'Hide after use' : {   
      cs: 'Skryj po použití'
      ,de: 'Verberge nach Gebrauch'
      ,es: 'Ocultar después de utilizar'
      ,fr: 'Cacher après utilisation'
      ,pt: 'Ocultar após uso'
      ,ro: 'Ascunde după folosireaa'
      ,bg: 'Скрий след употреба'
      ,hr: 'Sakrij nakon korištenja'
      ,sv: 'Dölj efter användning'
      }
    ,'Your API secret must be at least 12 characters long' : {   
      cs: 'Vaše API heslo musí mít alespoň 12 znaků'
      ,de: 'Deine API-Prüfsumme muss mindestens 12 Zeichen lang sein'
      ,es: 'Su secreo API debe contener al menos 12 caracteres'
      ,fr: 'Votre secret API doit contenir au moins 12 caractères'
      ,pt: 'Seu segredo de API deve conter no mínimo 12 caracteres'
      ,ro: 'Cheia API trebuie să aibă mai mult de 12 caractere'
      ,bg: 'Вашата АPI парола трябва да е дълга поне 12 символа'
      ,hr: 'Vaš tajni API mora sadržavati barem 12 znakova'
      ,sv: 'Hemlig API-nyckel måsta innehålla 12 tecken'
      }
    ,'Bad API secret' : {   
      cs: 'Chybné API heslo'
      ,de: 'Fehlerhafte API-Prüfsumme'
      ,es: 'Secreto API incorrecto'
      ,fr: 'Secret API erroné'
      ,pt: 'Segredo de API fraco'
      ,ro: 'Cheie API greșită'
      ,bg: 'Некоректна API парола'
      ,hr: 'Neispravan tajni API'
      ,sv: 'Felaktig API-nyckel'
      }
    ,'API secret hash stored' : {   
      cs: 'Hash API hesla uložen'
      ,de: 'API-Prüfsumme gespeichert'
      ,es: 'Hash de secreto API guardado'
      ,fr: 'Hash API secret sauvegardé'
      ,pt: 'Segredo de API guardado'
      ,ro: 'Cheie API înregistrată'
      ,bg: 'УРА! API парола запаметена'
      ,hr: 'API tajni hash je pohranjen'
      ,sv: 'Hemlig API-hash lagrad'
      }
    ,'Status' : {   
      cs: 'Status'
      ,de: 'Status'
      ,es: 'Estado'
      ,fr: 'Statut'
      ,pt: 'Status'
      ,sv: 'Status'
      ,ro: 'Status'
      ,bg: 'Статус'
      ,hr: 'Status'
      }
    ,'Not loaded' : {   
      cs: 'Nenačtený'
      ,de: 'Nicht geladen'
      ,es: 'No cargado'
      ,fr: 'Non chargé'
      ,pt: 'Não carregado'
      ,ro: 'Neîncărcat'
      ,bg: 'Не е заредено'
      ,hr: 'Nije učitano'
      ,sv: 'Ej laddad'
      }
    ,'Food editor' : {   
      cs: 'Editor jídel'
      ,de: 'Nahrungsmittel Editor'
      ,es: 'Editor de alimentos'
      ,fr: 'Editeur aliments'
      ,pt: 'Editor de alimentos'
      ,ro: 'Editor alimente'
      ,bg: 'Редактор за храна'
      ,hr: 'Editor hrane'
      ,sv: 'Födoämneseditor'
      }
    ,'Your database' : {   
      cs: 'Vaše databáze'
      ,de: 'Deine Datenbank'
      ,es: 'Su base de datos'
      ,fr: 'Votre base de données'
      ,pt: 'Seu banco de dados'
      ,sv: 'Din databas'
      ,ro: 'Baza de date'
      ,bg: 'Твоята база с данни'
      ,hr: 'Vaša baza podataka'
      }
    ,'Filter' : {   
      cs: 'Filtr'
      ,de: 'Filter'
      ,es: 'Filtro'
      ,fr: 'Filtre'
      ,pt: 'Filtro'
      ,sv: 'Filter'
      ,ro: 'Filtru'
      ,bg: 'Филтър'
      ,hr: 'Filter'
      }
    ,'Save' : {   
      cs: 'Ulož'
      ,de: 'Speichern'
      ,es: 'Salvar'
      ,fr: 'Sauver'
      ,pt: 'Salvar'
      ,ro: 'Salvează'
      ,bg: 'Запази'
      ,hr: 'Spremi'
      ,sv: 'Spara'
      }
    ,'Clear' : {   
      cs: 'Vymaž'
      ,de: 'Löschen'
      ,es: 'Limpiar'
      ,fr: 'Effacer'
      ,pt: 'Apagar'
      ,ro: 'Inițializare'
      ,bg: 'Изчисти'
      ,hr: 'Očisti'
      ,sv: 'Rensa'
      }
    ,'Record' : {   
      cs: 'Záznam'
      ,de: 'Datensatz'
      ,es: 'Guardar'
      ,fr: 'Enregistrement'
      ,pt: 'Gravar'
      ,sv: 'Post'
      ,ro: 'Înregistrare'
      ,bg: 'Запиши'
      ,hr: 'Zapis'
      }
    ,'Quick picks' : {   
      cs: 'Rychlý výběr'
      ,de: 'Schnellauswahl'
      ,es: 'Selección rápida'
      ,fr: 'Sélection rapide'
      ,pt: 'Seleção rápida'
      ,ro: 'Selecție rapidă'
      ,bg: 'Бърз избор'
      ,hr: 'Brzi izbor'
      ,sv: 'Snabbval'
      }
    ,'Show hidden' : {   
      cs: 'Zobraz skryté'
      ,de: 'Zeige verborgen'
      ,es: 'Mostrar ocultos'
      ,fr: 'Montrer cachés'
      ,pt: 'Mostrar ocultos'
      ,ro: 'Arată înregistrările ascunse'
      ,bg: 'Покажи скритото'
      ,hr: 'Prikaži skriveno'
      ,sv: 'Visa dolda'
      }
    ,'Your API secret' : {   
      cs: 'Vaše API heslo'
      ,de: 'Deine API Prüfsumme'
      ,es: 'Su secreto API'
      ,fr: 'Votre secret API'
      ,pt: 'Seu segredo de API'
      ,sv: 'Din API-nyckel'
      ,ro: 'Cheia API'
      ,bg: 'Твоята API парола'
      ,hr: 'Vaš tajni API'
      }
    ,'Store hash on this computer (Use only on private computers)' : {   
      cs: 'Ulož hash na tomto počítači (používejte pouze na soukromých počítačích)'
      ,de: 'Speichere Prüfsumme auf diesem Computer (nur auf privaten Computern anwenden)'
      ,es: 'Guardar hash en este ordenador (Usar solo en ordenadores privados)'
      ,fr: 'Sauver le hash sur cet ordinateur (privé uniquement)'
      ,pt: 'Salvar hash nesse computador (Somente em computadores privados)'
      ,ro: 'Salvează cheia pe acest PC (Folosiți doar PC de încredere)'
      ,bg: 'Запамети данните на този компютър. ( Използвай само на собствен компютър)'
      ,hr: 'Pohrani hash na ovom računalu (Koristiti samo na osobnom računalu)'
      ,sv: 'Lagra hashvärde på denna dator (använd endast på privat dator)'
      }
    ,'Treatments' : {   
      cs: 'Ošetření'
      ,de: 'Bearbeitung'
      ,es: 'Tratamientos'
      ,fr: 'Traitements'
      ,pt: 'Tratamentos'
      ,sv: 'Behandling'
      ,ro: 'Tratamente'
      ,bg: 'Събития'
      ,hr: 'Tretmani'
      }
    ,'Time' : {   
      cs: 'Čas'
      ,de: 'Zeit'
      ,es: 'Hora'
      ,fr: 'Heure'
      ,pt: 'Hora'
      ,sv: 'Tid'
      ,ro: 'Ora'
      ,bg: 'Време'
      ,hr: 'Vrijeme'
      }
    ,'Event Type' : {   
      cs: 'Typ události'
      ,de: 'Ereignis-Typ'
      ,es: 'Tipo de evento'
      ,fr: 'Type d\'événement'
      ,pt: 'Tipo de evento'
      ,sv: 'Händelsetyp'
      ,ro: 'Tip eveniment'
      ,bg: 'Вид събитие'
      ,hr: 'Vrsta događaja'
      }
    ,'Blood Glucose' : {   
      cs: 'Glykémie'
      ,de: 'Blutglukose'
      ,es: 'Glucemia'
      ,fr: 'Glycémie'
      ,pt: 'Glicemia'
      ,sv: 'Glukosvärde'
      ,ro: 'Glicemie'
      ,bg: 'Кръвна захар'
      ,hr: 'GUK'
      }
    ,'Entered By' : {   
      cs: 'Zadal'
      ,de: 'Eingabe durch'
      ,es: 'Introducido por'
      ,fr: 'Entré par'
      ,pt: 'Inserido por'
      ,sv: 'Inlagt av'
      ,ro: 'Introdus de'
      ,bg: 'Въведено от'
      ,hr: 'Unos izvršio'
      }
    ,'Delete this treatment?' : {   
      cs: 'Vymazat toto ošetření?'
      ,de: 'Bearbeitung löschen'
      ,es: '¿Borrar este tratamiento?'
      ,fr: 'Effacer ce traitement?'
      ,pt: 'Apagar este tratamento'
      ,ro: 'Șterge acest eveniment?'
      ,bg: 'Изтрий това събитие'
      ,hr: 'Izbriši ovaj tretman?'
      ,sv: 'Ta bort händelse?'
      }
    ,'Carbs Given' : {   
      cs: 'Sacharidů'
      ,de: 'Kohlenhydratgabe'
      ,es: 'Hidratos de carbono dados'
      ,fr: 'Glucides donnés'
      ,pt: 'Carboidratos'
      ,ro: 'Carbohidrați'
      ,bg: 'ВХ'
      ,hr: 'Količina UH'
      ,sv: 'Antal kolhydrater'
      }
    ,'Inzulin Given' : {   
      cs: 'Inzulínu'
      ,de: 'Insulingabe'
      ,es: 'Insulina dada'
      ,fr: 'Insuline donnée'
      ,pt: 'Insulina'
      ,ro: 'Insulină administrată'
      ,bg: 'Инсулин'
      ,hr: 'Količina inzulina'
      ,sv: 'Insulin'
      }
    ,'Event Time' : {   
      cs: 'Čas události'
      ,de: 'Ereignis Zeit'
      ,es: 'Hora del evento'
      ,fr: 'Heure de l\'événement'
      ,pt: 'Hora do evento'
      ,sv: 'Klockslag'
      ,ro: 'Ora evenimentului'
      ,bg: 'Въвеждане'
      ,hr: 'Vrijeme događaja'
      }
    ,'Please verify that the data entered is correct' : {   
      cs: 'Prosím zkontrolujte, zda jsou údaje zadány správně'
      ,de: 'Bitte Daten auf Plausibilität prüfen'
      ,es: 'Por favor, verifique que los datos introducidos son correctos'
      ,fr: 'Merci de vérifier la correction des données entrées'
      ,pt: 'Favor verificar se os dados estão corretos'
      ,ro: 'Verificați conexiunea datelor introduse'
      ,bg: 'Моля проверете, че датата е въведена правилно'
      ,hr: 'Molim Vas provjerite jesu li uneseni podaci ispravni'
      ,sv: 'Vänligen verifiera att inlagd data stämmer'
      }
    ,'BG' : {   
      cs: 'Glykémie'
      ,de: 'Blutglukose'
      ,es: 'Glucemia en sangre'
      ,fr: 'Glycémie'
      ,pt: 'Glicemia'
      ,sv: 'BS'
      ,ro: 'Glicemie'
      ,bg: 'КЗ'
      ,hr: 'GUK'
      }
    ,'Use BG correction in calculation' : {   
      cs: 'Použij korekci na glykémii'
      ,de: 'Verwende Blutglukose-Korrektur zur Kalkulation'
      ,es: 'Usar la corrección de glucemia en los cálculos'
      ,fr: 'Utiliser la correction de glycémie dans les calculs'
      ,pt: 'Usar correção de glicemia nos cálculos'
      ,ro: 'Folosește corecția de glicemie în calcule'
      ,bg: 'Въведи корекция за КЗ  '
      ,hr: 'Koristi korekciju GUK-a u izračunu'
      ,sv: 'Använd BS-korrektion för uträkning'
      }
    ,'BG from CGM (autoupdated)' : {   
      cs: 'Glykémie z CGM (automaticky aktualizovaná)'
      ,de: 'Blutglukose vom CGM (Autoupdate)'
      ,es: 'Glucemia del sensor (Actualizado automáticamente)'
      ,fr: 'Glycémie CGM (automatique)'
      ,pt: 'Glicemia do sensor (Automático)'
      ,sv: 'BS från CGM (automatiskt)'
      ,ro: 'Glicemie în senzor (automat)'
      ,bg: 'КЗ от сензора (автоматично)'
      ,hr: 'GUK sa CGM-a (ažuriran automatski)'
      }
    ,'BG from meter' : {   
      cs: 'Glykémie z glukoměru'
      ,de: 'Blutzucker vom Messgerät'
      ,es: 'Glucemia del glucómetro'
      ,fr: 'Glycémie de glucomètre'
      ,pt: 'Glicemia do glicosímetro'
      ,sv: 'BS från blodsockermätare'
      ,ro: 'Glicemie în glucometru'
      ,bg: 'КЗ от глюкомер'
      ,hr: 'GUK s glukometra'
      }
    ,'Manual BG' : {   
      cs: 'Ručně zadaná glykémie'
      ,de: 'Blutzucker händisch'
      ,es: 'Glucemia manual'
      ,fr: 'Glycémie manuelle'
      ,pt: 'Glicemia Manual'
      ,ro: 'Glicemie manuală'
      ,bg: 'Ръчно въведена КЗ'
      ,hr: 'Ručno unesen GUK'
      ,sv: 'Manuellt BS'
      }
    ,'Quickpick' : {   
      cs: 'Rychlý výběr'
      ,de: 'Schnellauswahl'
      ,es: 'Selección rápida'
      ,fr: 'Sélection rapide'
      ,pt: 'Seleção rápida'
      ,ro: 'Selecție rapidă'
      ,bg: 'Бърз избор'
      ,hr: 'Brzi izbor'
      ,sv: 'Snabbval'
      }
    ,'or' : {   
      cs: 'nebo'
      ,de: 'oder'
      ,es: 'o'
      ,fr: 'ou'
      ,pt: 'or'
      ,sv: 'Eller'
      ,ro: 'sau'
      ,bg: 'или'
      ,hr: 'ili'
      }
    ,'Add from database' : {   
      cs: 'Přidat z databáze'
      ,de: 'Ergänzt aus Datenbank'
      ,es: 'Añadir desde la base de datos'
      ,fr: 'Ajouter à partir de la base de données'
      ,pt: 'Adicionar do banco de dados'
      ,ro: 'Adaugă din baza de date'
      ,bg: 'Добави към базата с данни'
      ,hr: 'Dodaj iz baze podataka'
      ,sv: 'Lägg till från databas'
      }
    ,'Use carbs correction in calculation' : {   
      cs: 'Použij korekci na sacharidy'
      ,de: 'Verwende Kohlenhydrate-Korrektur zur Kalkulation'
      ,es: 'Usar la corrección de hidratos de carbono en los cálculos'
      ,fr: 'Utiliser la correction en glucides dans les calculs'
      ,pt: 'Usar correção com carboidratos no cálculo'
      ,ro: 'Folosește corecția de carbohidrați în calcule'
      ,bg: 'Въведи корекция за въглехидратите'
      ,hr: 'Koristi korekciju za UH u izračunu'
      ,sv: 'Använd kolhydratkorrektion i utäkning'
      }
    ,'Use COB correction in calculation' : {   
      cs: 'Použij korekci na COB'
      ,de: 'Verwende verzehrte Kohlenhydrate zur Kalkulation'
      ,es: 'Usar la corrección de COB en los cálculos'
      ,fr: 'Utiliser les COB dans les calculs'
      ,pt: 'Usar COB no cálculo'
      ,ro: 'Folosește COB în calcule'
      ,bg: 'Въведи корекция за останалите въглехидрати'
      ,hr: 'Koristi aktivne UH u izračunu'
      ,sv: 'Använd aktiva kolhydrater för beräkning'
      }
    ,'Use IOB in calculation' : {   
      cs: 'Použij IOB ve výpočtu'
      ,de: 'Verwende gespritzes Insulin zur Kalkulation'
      ,es: 'Usar la IOB en los cálculos'
      ,fr: 'Utiliser l\'IOB dans les calculs'
      ,pt: 'Usar IOB no cálculo'
      ,ro: 'Folosește IOB în calcule'
      ,bg: 'Използвай активния инсулин'
      ,hr: 'Koristi aktivni inzulin u izračunu"'
      ,sv: 'Använd aktivt insulin för uträkning'
      }
    ,'Other correction' : {   
      cs: 'Jiná korekce'
      ,de: 'Weitere Korrektur'
      ,es: 'Otra correción'
      ,fr: 'Autre correction'
      ,pt: 'Outra correção'
      ,ro: 'Alte corecții'
      ,bg: 'Друга корекция'
      ,hr: 'Druga korekcija'
      ,sv: 'Övrig korrektion'
      }
    ,'Rounding' : {   
      cs: 'Zaokrouhlení'
      ,de: 'Gerundet'
      ,es: 'Redondeo'
      ,fr: 'Arrondi'
      ,pt: 'Arredondamento'
      ,sv: 'Avrundning'
      ,ro: 'Rotunjire'
      ,bg: 'Закръгляне'
      ,hr: 'Zaokruživanje'
	  }
    ,'Enter insulin correction in treatment' : {   
      cs: 'Zahrň inzulín do záznamu ošetření'
      ,de: 'Insulin Korrektur zur Behandlung eingeben'
      ,es: 'Introducir correción de insulina en tratamiento'
      ,fr: 'Entrer correction insuline dans le traitement'
      ,pt: 'Inserir correção de insulina no tratamento'
      ,ro: 'Introdu corecția de insulină în tratament'
      ,bg: 'Въведи корекция с инсулин като лечение'
      ,hr: 'Unesi korekciju inzulinom u tretman'
      ,sv: 'Ange insulinkorrektion för händelse'
      }
    ,'Insulin needed' : {   
      cs: 'Potřebný inzulín'
      ,de: 'Benötigtes Insulin'
      ,es: 'Insulina necesaria'
      ,fr: 'Insuline nécessaire'
      ,pt: 'Insulina necessária'
      ,ro: 'Necesar insulină'
      ,bg: 'Необходим инсулин'
      ,hr: 'Potrebno inzulina'
      ,sv: 'Beräknad insulinmängd'
      }
    ,'Carbs needed' : {   
      cs: 'Potřebné sach'
      ,de: 'Benötigte Kohlenhydrate'
      ,es: 'Hidratos de carbono necesarios'
      ,fr: 'Glucides nécessaires'
      ,pt: 'Carboidratos necessários'
      ,ro: 'Necesar carbohidrați'
      ,bg: 'Необходими въглехидрати'
      ,hr: 'Potrebno UH'
      ,sv: 'Beräknad kolhydratmängd'
      }
    ,'Carbs needed if Insulin total is negative value' : {   
      cs: 'Chybějící sacharidy v případě, že výsledek je záporný'
      ,de: 'Benötigte Kohlenhydrate sofern Gesamtinsulin einen negativen Wert aufweist'
      ,es: 'Hidratos de carbono necesarios si el total de insulina es un valor negativo'
      ,fr: 'Glucides nécessaires si insuline totale est un valeur négative'
      ,pt: 'Carboidratos necessários se Insulina total for negativa'
      ,ro: 'Carbohidrați când necesarul de insulină este negativ'
      ,bg: 'Необходими въглехидрати, ако няма инсулин'
      ,hr: 'Potrebno UH ako je ukupna vrijednost inzulina negativna'
      ,sv: 'Nödvändig kolhydratmängd för angiven insulinmängd'
      }
    ,'Basal rate' : {   
      cs: 'Bazál'
      ,de: 'Basalrate'
      ,es: 'Tasa basal'
      ,fr: 'Taux basal'
      ,pt: 'Taxa basal'
      ,ro: 'Rata bazală'
      ,bg: 'Базален инсулин'
      ,hr: 'Bazal'
      ,sv: 'Basaldos'
      }
    ,'60 minutes earlier' : {   
      cs: '60 min předem'
      ,de: '60 Min. früher'
      ,es: '60 min antes'
      ,fr: '60 min avant'
      ,pt: '60 min antes'
      ,sv: '60 min tidigare'
      ,ro: 'acum 60 min'
      ,bg: 'Преди 60 минути'
      ,hr: 'Prije 60 minuta'
      }
    ,'45 minutes earlier' : {   
      cs: '45 min předem'
      ,de: '45 Min. früher'
      ,es: '45 min antes'
      ,fr: '45 min avant'
      ,pt: '45 min antes'
      ,sv: '45 min tidigare'
      ,ro: 'acum 45 min'
      ,bg: 'Преди 45 минути'
      ,hr: 'Prije 45 minuta'
      }
    ,'30 minutes earlier' : {   
      cs: '30 min předem'
      ,de: '30 Min früher'
      ,es: '30 min antes'
      ,fr: '30 min avant'
      ,pt: '30 min antes'
      ,sv: '30 min tidigare'
      ,ro: 'acum 30 min'
      ,bg: 'Преди 30 минути'
      ,hr: 'Prije 30 minuta'
      }
    ,'20 minutes earlier' : {   
      cs: '20 min předem'
      ,de: '20 Min. früher'
      ,es: '20 min antes'
      ,fr: '20 min avant'
      ,pt: '20 min antes'
      ,sv: '20 min tidigare'
      ,ro: 'acum 20 min'
      ,bg: 'Преди 20 минути'
      ,hr: 'Prije 20 minuta'
      }
    ,'15 minutes earlier' : {   
      cs: '15 min předem'
      ,de: '15 Min. früher'
      ,es: '15 min antes'
      ,fr: '15 min avant'
      ,pt: '15 min antes'
      ,sv: '15 min tidigare'
      ,ro: 'acu 15 min'
      ,bg: 'Преди 15 минути'
      ,hr: 'Prije 15 minuta'
      }
    ,'Time in minutes' : {   
      cs: 'Čas v minutách'
      ,de: 'Zeit in Minuten'
      ,es: 'Tiempo en minutos'
      ,fr: 'Durée en minutes'
      ,pt: 'Tempo em minutos'
      ,sv: 'Tid i minuter'
      ,ro: 'Timp în minute'
      ,bg: 'Времето в минути'
      ,hr: 'Vrijeme u minutama'
      }
    ,'15 minutes later' : {   
      cs: '15 min po'
      ,de: '15 Min. später'
      ,es: '15 min más tarde'
      ,fr: '15 min après'
      ,ro: 'după 15 min'
      ,bg: 'След 15 минути'
      ,hr: '15 minuta kasnije'
      ,sv: '15 min senare'
      }
    ,'20 minutes later' : {   
      cs: '20 min po'
      ,de: '20 Min. später'
      ,es: '20 min más tarde'
      ,fr: '20 min après'
      ,pt: '20 min depois'
      ,ro: 'după 20 min'
      ,bg: 'След 20 минути'
      ,hr: '20 minuta kasnije'
      ,sv: '20 min senare'
      }
    ,'30 minutes later' : {   
      cs: '30 min po'
      ,de: '30 Min. später'
      ,es: '30 min más tarde'
      ,fr: '30 min après'
      ,pt: '30 min depois'
      ,ro: 'după 30 min'
      ,bg: 'След 30 минути'
      ,hr: '30 minuta kasnije'
      ,sv: '30 min senare'
      }
    ,'45 minutes later' : {   
      cs: '45 min po'
      ,de: '45 Min. später'
      ,es: '45 min más tarde'
      ,fr: '45 min après'
      ,pt: '45 min depois'
      ,ro: 'după 45 min'
      ,bg: 'След 45 минути'
      ,hr: '45 minuta kasnije'
      ,sv: '45 min senare'
      }
    ,'60 minutes later' : {   
      cs: '60 min po'
      ,de: '60 Min. später'
      ,es: '60 min más tarde'
      ,fr: '60 min après'
      ,pt: '60 min depois'
      ,ro: 'după 60 min'
      ,bg: 'След 60 минути'
      ,hr: '60 minuta kasnije'
      ,sv: '60 min senare'
      }
    ,'Additional Notes, Comments' : {   
      cs: 'Dalši poznámky, komentáře'
      ,de: 'Ergänzende Hinweise / Kommentare'
      ,es: 'Notas adicionales, Comentarios'
      ,fr: 'Notes additionnelles, commentaires'
      ,pt: 'Notas adicionais e comentários'
      ,ro: 'Note adiționale, comentarii'
      ,bg: 'Допълнителни бележки, коментари'
      ,hr: 'Dodatne bilješke, komentari'
      ,sv: 'Notering, övrigt'
      }
    ,'RETRO MODE' : {   
      cs: 'V MINULOSTI'
      ,de: 'RETRO MODUS'
      ,es: 'Modo Retrospectivo'
      ,fr: 'MODE RETROSPECTIF'
      ,pt: 'Modo Retrospectivo'
      ,sv: 'Retroläge'
      ,ro: 'MOD RETROSPECTIV'
      ,bg: 'МИНАЛО ВРЕМЕ'
      ,hr: 'Retrospektivni način'
      }
    ,'Now' : {   
      cs: 'Nyní'
      ,de: 'Jetzt'
      ,es: 'Ahora'
      ,fr: 'Maintenant'
      ,pt: 'Agora'
      ,sv: 'Nu'
      ,ro: 'Acum'
      ,bg: 'Сега'
      ,hr: 'Sad'
      }
    ,'Other' : {   
      cs: 'Jiný'
      ,de: 'Weitere'
      ,es: 'Otro'
      ,fr: 'Autre'
      ,pt: 'Outro'
      ,sv: 'Övrigt'
      ,ro: 'Altul'
      ,bg: 'Друго'
      ,hr: 'Drugo'
      }
    ,'Submit Form' : {   
      cs: 'Odeslat formulář'
      ,de: 'Eingabe senden'
      ,es: 'Enviar formulario'
      ,fr: 'Formulaire de soumission'
      ,pt: 'Submeter formulário'
      ,sv: 'Överför händelse'
      ,ro: 'Trimite formularul'
      ,bg: 'Въвеждане на данните'
      ,hr: 'Predaj obrazac'
      }
    ,'Profile editor' : {   
      cs: 'Editor profilu'
      ,de: 'Profil-Einstellungen'
      ,es: 'Editor de perfil'
      ,fr: 'Editeur de profil'
      ,pt: 'Editor de perfil'
      ,sv: 'Editera profil'
      ,ro: 'Editare profil'
      ,bg: 'Редактор на профила'
      ,hr: 'Editor profila'
      }
    ,'Reporting tool' : {   
      cs: 'Výkazy'
      ,de: 'Berichte'
      ,es: 'Herramienta de informes'
      ,fr: 'Outil de rapport'
      ,pt: 'Ferramenta de relatórios'
      ,sv: 'Rapportverktyg'
      ,ro: 'Instrument de rapoarte'
      ,bg: 'Статистика'
      ,hr: 'Alat za prijavu'
      }
    ,'Add food from your database' : {   
      cs: 'Přidat jidlo z Vaší databáze'
      ,de: 'Ergänzt durch deine Datenbank'
      ,es: 'Añadir alimento a su base de datos'
      ,fr: 'Ajouter aliment de votre base de données'
      ,pt: 'Incluir alimento do seu banco de dados'
      ,ro: 'Adaugă alimente din baza de date'
      ,bg: 'Добави храна от твоята база с данни'
      ,hr: 'Dodajte hranu iz svoje baze podataka'
      ,sv: 'Lägg till livsmedel från databas'
      }
    ,'Reload database' : {   
      cs: 'Znovu nahraj databázi'
      ,de: 'Datenbank nachladen'
      ,es: 'Recargar base de datos'
      ,fr: 'Recharger la base de données'
      ,pt: 'Recarregar banco de dados'
      ,ro: 'Reîncarcă baza de date'
      ,bg: 'Презареди базата с данни'
      ,hr: 'Ponovo učitajte bazu podataka'
      ,sv: 'Ladda om databas'
      }
    ,'Add' : {   
      cs: 'Přidej'
      ,de: 'Hinzufügen'
      ,es: 'Añadir'
      ,fr: 'Ajouter'
      ,pt: 'Adicionar'
      ,ro: 'Adaugă'
      ,bg: 'Добави'
      ,hr: 'Dodaj'
      ,sv: 'Lägg till'
      }
    ,'Unauthorized' : {   
      cs: 'Neautorizováno'
      ,de: 'Unbestätigt'
      ,es: 'No autorizado'
      ,fr: 'Non autorisé'
      ,pt: 'Não autorizado'
      ,sv: 'Ej behörig'
      ,ro: 'Neautorizat'
      ,bg: 'Нямаш достъп'
      ,hr: 'Neautorizirano'
      }
    ,'Entering record failed' : {   
      cs: 'Vložení záznamu selhalo'
      ,de: 'Eingabe Datensatz fehlerhaft'
      ,es: 'Entrada de registro fallida'
      ,fr: 'Entrée enregistrement a échoué'
      ,pt: 'Entrada de registro falhou'
      ,ro: 'Înregistrare eșuată'
      ,bg: 'Въвеждане на записа не се осъществи'
      ,hr: 'Neuspjeli unos podataka'
      ,sv: 'Lägga till post nekas'
      }
    ,'Device authenticated' : {   
      cs: 'Zařízení ověřeno'
      ,de: 'Gerät authentifiziert'
      ,es: 'Dispositivo autenticado'
      ,fr: 'Appareil authentifié'
      ,pt: 'Dispositivo autenticado'
      ,sv: 'Enhet autentiserad'
      ,ro: 'Dispozitiv autentificat'
      ,bg: 'Устройстово е разпознато'
      ,hr: 'Uređaj autenticiran'
      }
    ,'Device not authenticated' : {   
      cs: 'Zařízení není ověřeno'
      ,de: 'Gerät nicht authentifiziert'
      ,es: 'Dispositivo no autenticado'
      ,fr: 'Appareil non authentifié'
      ,pt: 'Dispositivo não autenticado'
      ,sv: 'Enhet EJ autentiserad'
      ,ro: 'Dispozitiv neautentificat'
      ,bg: 'Устройсройството не е разпознато'
      ,hr: 'Uređaj nije autenticiran'
      }
    ,'Authentication status' : {   
      cs: 'Stav ověření'
      ,de: 'Authentifications Status'
      ,es: 'Estado de autenticación'
      ,fr: 'Status de l\'authentification'
      ,pt: 'Status de autenticação'
      ,ro: 'Starea autentificării'
      ,bg:  'Статус на удостоверяване'
      ,hr: 'Status autentikacije'
      ,sv: 'Autentiseringsstatus'
      }
    ,'Authenticate' : {   
      cs: 'Ověřit'
      ,de: 'Authentifizieren'
      ,es: 'Autenticar'
      ,fr: 'Authentifier'
      ,pt: 'Autenticar'
      ,sv: 'Autentiserar'
      ,ro: 'Autentificare'
      ,bg: 'Удостоверяване'
      ,hr: 'Autenticirati'
      }
    ,'Remove' : {   
      cs: 'Vymazat'
      ,de: 'Entfernen'
      ,es: 'Eliminar'
      ,fr: 'Retirer'
      ,pt: 'Remover'
      ,ro: 'Șterge'
      ,bg: 'Премахни'
      ,hr: 'Ukloniti'
      ,sv: 'Ta bort'
      }
    ,'Your device is not authenticated yet' : {
      cs: 'Toto zařízení nebylo dosud ověřeno'
      ,de: 'Dein Gerät ist derzeit nicht authentifiziert'
      ,es: 'Su dispositivo no ha sido autenticado todavía'
      ,fr: 'Votre appareil n\'est pas encore authentifié'
      ,pt: 'Seu dispositivo ainda não foi autenticado'
      ,ro: 'Dispozitivul nu este autentificat încă'
      ,bg: 'Вашето устройство все още не е удостоверено'
      ,hr: 'Vaš uređaj još nije autenticiran'
      ,sv: 'Din enhet är ej autentiserad'
      }
    ,'Sensor' : {   
      cs: 'Senzor'
      ,de: 'Sensor'
      ,es: 'Sensor'
      ,fr: 'Senseur'
      ,pt: 'Sensor'
      ,sv: 'Sensor'
      ,ro: 'Senzor'
      ,bg: 'Сензор'
      ,hr: 'Senzor'
      }
    ,'Finger' : {   
      cs: 'Glukoměr'
      ,de: 'Finger'
      ,es: 'Dedo'
      ,fr: 'Doigt'
      ,pt: 'Dedo'
      ,sv: 'Finger'
      ,ro: 'Deget'
      ,bg: 'От пръстта'
      ,hr: 'Prst'
      }
    ,'Manual' : {   
      cs: 'Ručně'
      ,de: 'Händisch'
      ,es: 'Manual'
      ,fr: 'Manuel'
      ,pt: 'Manual'
      ,sv: 'Manuell'
      ,ro: 'Manual'
      ,bg: 'Ръчно'
      ,hr: 'Ručno'
      }
    ,'Scale' : {   
      cs: 'Měřítko'
      ,de: 'Messen'
      ,es: 'Escala'
      ,fr: 'Echelle'
      ,pt: 'Escala'
      ,ro: 'Scală'
      ,bg: 'Скала'
      ,hr: 'Skala'
      ,sv: 'Skala'
      }
    ,'Linear' : {   
      cs: 'lineární'
      ,de: 'Linear'
      ,es: 'Lineal'
      ,fr: 'Linéaire'
      ,pt: 'Linear'
      ,sv: 'Linjär'
      ,ro: 'Liniar'
      ,bg: 'Линеен'
      ,hr: 'Linearno'
      }
    ,'Logarithmic' : {   
      cs: 'logaritmické'
      ,de: 'Logarithmisch'
      ,es: 'Logarítmica'
      ,fr: 'Logarithmique'
      ,pt: 'Logarítmica'
      ,sv: 'Logaritmisk'
      ,ro: 'Logaritmic'
      ,bg: 'Логоритмичен'
      ,hr: 'Logaritamski'
      }
    ,'Silence for 30 minutes' : {   
      cs: 'Ztlumit na 30 minut'
      ,de: 'Ausschalten für 30 Minuten'
      ,es: 'Silenciar durante 30 minutos'
      ,fr: 'Silence pendant 30 minutes'
      ,pt: 'Silenciar por 30 minutos'
      ,ro: 'Ignoră pentru 30 minute'
      ,bg: 'Заглуши за 30 минути'
      ,hr: 'Tišina 30 minuta'
      ,sv: 'Tyst i 30 min'
      }
    ,'Silence for 60 minutes' : {   
      cs: 'Ztlumit na 60 minut'
      ,de: 'Ausschalten für 60 Minuten'
      ,es: 'Silenciar durante 60 minutos'
      ,fr: 'Silence pendant 60 minutes'
      ,pt: 'Silenciar por 60 minutos'
      ,ro: 'Ignoră pentru 60 minute'
      ,bg: 'Заглуши за 60 минути'
      ,hr: 'Tišina 60 minuta'
      ,sv: 'Tyst i 60 min'
      }
    ,'Silence for 90 minutes' : {   
      cs: 'Ztlumit na 90 minut'
      ,de: 'Ausschalten für 90 Minuten'
      ,es: 'Silenciar durante 90 minutos'
      ,fr: 'Silence pendant 90 minutes'
      ,pt: 'Silenciar por 90 minutos'
      ,ro: 'Ignoră pentru 90 minure'
      ,bg: 'Заглуши за 90 минути'
      ,hr: 'Tišina 90 minuta'
      ,sv: 'Tyst i 90 min'
      }
    ,'Silence for 120 minutes' : {   
      cs: 'Ztlumit na 120 minut'
      ,de: 'Ausschalten für 120 Minuten'
      ,es: 'Silenciar durante 120 minutos'
      ,fr: 'Silence pendant 120 minutes'
      ,pt: 'Silenciar por 120 minutos'
      ,ro: 'Ignoră pentru 120 minute'
      ,bg: 'Заглуши за 120 минути'
      ,hr: 'Tišina 120 minuta'
      ,sv: 'Tyst i 120 min'
      }
    ,'3HR' : {   
      cs: '3hod'
      ,de: '3h'
      ,es: '3h'
      ,fr: '3hr'
      ,pt: '3h'
      ,sv: '3tim'
      ,ro: '3h'
      ,bg: '3часа'
      ,hr: '3h'
      }
    ,'6HR' : {   
      cs: '6hod'
      ,de: '6h'
      ,es: '6h'
      ,fr: '6hr'
      ,pt: '6h'
      ,sv: '6tim'
      ,ro: '6h'
      ,bg: '6часа'
      ,hr: '6h'
      }
    ,'12HR' : {   
      cs: '12hod'
      ,de: '12h'
      ,es: '12h'
      ,fr: '12hr'
      ,pt: '12h'
      ,sv: '12tim'
      ,ro: '12h'
      ,bg: '12часа'
      ,hr: '12h'
      }
    ,'24HR' : {   
      cs: '24hod'
      ,de: '24h'
      ,es: '24h'
      ,fr: '24hr'
      ,pt: '24h'
      ,sv: '24tim'
      ,ro: '24h'
      ,bg: '24часа'
      ,hr: '24h'
      }
    ,'Settings' : {
      cs: 'Nastavení'
      ,de: 'Einstellungen'
      ,es: 'Ajustes'
      ,fr: 'Paramètres'
      ,pt: 'Definições'
      ,ro: 'Setări'
      ,bg: 'Настройки'
      ,hr: 'Postavke'
      }
    ,'Units' : {
      cs: 'Jednotky'
      ,de: 'Einheiten'
      ,es: 'Unidades'
      ,fr: 'Unités'
      ,pt: 'Unidades'
      ,ro: 'Unități'
      ,bg: 'Единици'
      ,hr: 'Jedinice'
      ,sv: 'Enheter'
      }
    ,'Date format' : {   
      cs: 'Formát datumu'
      ,de: 'Datum Format'
      ,es: 'Formato de fecha'
      ,fr: 'Format Date'
      ,pt: 'Formato de data'
      ,sv: 'Datumformat'
      ,ro: 'Formatul datei'
      ,bg: 'Формат на датата'
      ,hr: 'Format datuma'
      }
    ,'12 hours' : {   
      cs: '12 hodin'
      ,de: '12 Stunden'
      ,es: '12 horas'
      ,fr: '12hr'
      ,pt: '12 horas'
      ,sv: '12-timmars'
      ,ro: '12 ore'
      ,bg: '12 часа'
      ,hr: '12 sati'
      }
    ,'24 hours' : {   
      cs: '24 hodin'
      ,de: '24 Stunden'
      ,es: '24 horas'
      ,fr: '24hr'
      ,pt: '24 horas'
      ,sv: '24-timmars'
      ,ro: '24 ore'
      ,bg: '24 часа'
      ,hr: '24 sata'
      }
    ,'Log a Treatment' : {   
      cs: 'Záznam ošetření'
      ,de: 'Dateneingabe'
      ,es: 'Apuntar un tratamiento'
      ,fr: 'Entrer un traitement'
      ,pt: 'Entre um tratamento'
      ,ro: 'Înregistrează un eveniment'
      ,bg: 'Въвеждане на събитие'
      ,hr: 'Evidencija tretmana'
      ,sv: 'Ange händelse'
      }
    ,'BG Check' : {   
      cs: 'Kontrola glykémie'
      ,de: 'Blutglukose-Prüfung'
      ,es: 'Control de glucemia'
      ,fr: 'Contrôle glycémie'
      ,pt: 'Medida de glicemia'
      ,sv: 'BS-kontroll'
      ,ro: 'Verificare glicemie'
      ,bg: 'Проверка на КЗ'
      ,hr: 'Kontrola GUK-a'
      }
    ,'Meal Bolus' : {   
      cs: 'Bolus na jídlo'
      ,de: 'Mahlzeiten Bolus'
      ,es: 'Bolo de comida'
      ,fr: 'Bolus repas'
      ,pt: 'Bolus de refeição'
      ,ro: 'Bolus masă'
      ,bg: 'Болус-основно хранене'
      ,hr: 'Bolus za obrok'
      ,sv: 'Måltidsbolus'
      }
    ,'Snack Bolus' : {   
      cs: 'Bolus na svačinu'
      ,de: 'Snack Bolus'
      ,es: 'Bolo de aperitivo'
      ,fr: 'Bolus friandise'
      ,pt: 'Bolus de lanche'
      ,sv: 'Mellanmålsbolus'
      ,ro: 'Bolus gustare'
      ,bg: 'Болус-лека закуска'
      ,hr: 'Bolus za užinu'
      }
    ,'Correction Bolus' : {   
      cs: 'Bolus na glykémii'
      ,de: 'Korrektur Bolus'
      ,es: 'Bolo corrector'
      ,fr: 'Bolus de correction'
      ,pt: 'Bolus de correção'
      ,ro: 'Bolus corecție'
      ,bg: 'Болус корекция'
      ,hr: 'Korekcija'
      ,sv: 'Korrektionsbolus'
      }
    ,'Carb Correction' : {   
      cs: 'Přídavek sacharidů'
      ,de: 'Kohlenhydrate Korrektur'
      ,es: 'Hidratos de carbono de corrección'
      ,fr: 'Correction glucide'
      ,pt: 'Carboidrato de correção'
      ,ro: 'Corecție de carbohidrați'
      ,bg: 'Корекция за въглехидратите'
      ,hr: 'Bolus za hranu'
      ,sv: 'Kolhydratskorrektion'
      }
    ,'Note' : {   
      cs: 'Poznámka'
      ,de: 'Bemerkungen'
      ,es: 'Nota'
      ,fr: 'Note'
      ,pt: 'Nota'
      ,ro: 'Notă'
      ,bg: 'Бележка'
      ,hr: 'Bilješka'
      ,sv: 'Notering'
      }
    ,'Question' : {   
      cs: 'Otázka'
      ,de: 'Frage'
      ,es: 'Pregunta'
      ,fr: 'Question'
      ,pt: 'Pergunta'
      ,sv: 'Fråga'
      ,ro: 'Întrebare'
      ,bg: 'Въпрос'
      ,hr: 'Pitanje'
      }
    ,'Exercise' : {   
      cs: 'Cvičení'
      ,de: 'Bewegung'
      ,es: 'Ejercicio'
      ,fr: 'Exercice'
      ,pt: 'Exercício'
      ,ro: 'Activitate fizică'
      ,bg: 'Спорт'
      ,hr: 'Aktivnost'
      ,sv: 'Aktivitet'
      }
    ,'Pump Site Change' : {   
      cs: 'Přepíchnutí kanyly'
      ,de: 'Pumpen-Katheter Wechsel'
      ,es: 'Cambio de catéter'
      ,fr: 'Changement de site pompe'
      ,pt: 'Troca de catéter'
      ,ro: 'Schimbare loc pompă'
      ,bg: 'Смяна на сет'
      ,hr: 'Promjena seta'
      ,sv: 'Pump/nålbyte'
      }
    ,'Sensor Start' : {   
      cs: 'Spuštění sensoru'
      ,de: 'Sensor Start'
      ,es: 'Inicio de sensor'
      ,fr: 'Démarrage senseur'
      ,pt: 'Início de sensor'
      ,sv: 'Sensorstart'
      ,ro: 'Start senzor'
      ,bg: 'Стартиране на сензор'
      ,hr: 'Start senzora'
      }
    ,'Sensor Change' : {   
      cs: 'Výměna sensoru'
      ,de: 'Sensor Wechsel'
      ,es: 'Cambio de sensor'
      ,fr: 'Changement senseur'
      ,pt: 'Troca de sensor'
      ,sv: 'Sensorbyte'
      ,ro: 'Schimbare senzor'
      ,bg: 'Смяна на сензор'
      ,hr: 'Promjena senzora'
      }
    ,'Dexcom Sensor Start' : {   
      cs: 'Spuštění sensoru'
      ,de: 'Dexcom Sensor Start'
      ,es: 'Inicio de sensor Dexcom'
      ,fr: 'Démarrage senseur Dexcom'
      ,pt: 'Início de sensor Dexcom'
      ,sv: 'Dexcom sensorstart'
      ,ro: 'Pornire senzor Dexcom'
      ,bg: 'Поставяне на Декском сензор'
      ,hr: 'Start Dexcom senzora'
      }
    ,'Dexcom Sensor Change' : {   
      cs: 'Výměna sensoru'
      ,de: 'Dexcom Sensor Wechsel'
      ,es: 'Cambio de sensor Dexcom'
      ,fr: 'Changement senseur Dexcom'
      ,pt: 'Troca de sensor Dexcom'
      ,sv: 'Dexcom sensorbyte'
      ,ro: 'Schimbare senzor Dexcom'
      ,bg: 'Смяна на Декском сензор'
      ,hr: 'Promjena Dexcom senzora'
      }
    ,'Insulin Cartridge Change' : {   
      cs: 'Výměna inzulínu'
      ,de: 'Insulin Ampullen Wechsel'
      ,es: 'Cambio de reservorio de insulina'
      ,fr: 'Changement cartouche d\'insuline'
      ,pt: 'Troca de reservatório de insulina'
      ,ro: 'Schimbare cartuș insulină'
      ,bg: 'Смяна на резервоар'
      ,hr: 'Promjena spremnika inzulina'
      ,sv: 'Insulinreservoarbyte'
      }
    ,'D.A.D. Alert' : {   
      cs: 'D.A.D. Alert'
      ,de: 'Diabetes-Hund Alarm'
      ,es: 'Alerta de perro de alerta diabética'
      ,fr: 'Wouf! Wouf! Chien d\'alerte diabète'
      ,pt: 'Alerta de cão sentinela de diabetes'
      ,ro: 'Alertă câine de serviciu'
      ,bg: 'Сигнал от обучено куче'
      ,hr: 'Obavijest dijabetičkog psa'
      ,sv: 'Voff voff! (Diabeteshundalarm!)'
      }
    ,'Glucose Reading' : {   
      cs: 'Hodnota glykémie'
      ,de: 'Glukose Messwert'
      ,es: 'Valor de glucemia'
      ,fr: 'Valeur de glycémie'
      ,pt: 'Valor de glicemia'
      ,sv: 'Blodglukosavläsning'
      ,ro: 'Valoare glicemie'
      ,bg: 'Кръвна захар'
      ,hr: 'Vrijednost GUK-a'
      }
    ,'Measurement Method' : {   
      cs: 'Metoda měření'
      ,de: 'Messmethode'
      ,es: 'Método de medida'
      ,fr: 'Méthode de mesure'
      ,pt: 'Método de medida'
      ,ro: 'Metodă măsurare'
      ,bg: 'Метод на измерване'
      ,hr: 'Metoda mjerenja'
      ,sv: 'Mätmetod'
      }
    ,'Meter' : {   
      cs: 'Glukoměr'
      ,de: 'BZ-Messgerät'
      ,fr: 'Glucomètre'
      ,pt: 'Glicosímetro'
      ,sv: 'Mätare'
      ,ro: 'Glucometru'
      ,es: 'Glucómetro'
      ,bg: 'Глюкомер'
      ,hr: 'Glukometar'
      }
    ,'Insulin Given' : {   
      cs: 'Inzulín'
      ,de: 'Insulingabe'
      ,es: 'Insulina'
      ,fr: 'Insuline donnée'
      ,pt: 'Insulina'
      ,ro: 'Insulină administrată'
      ,bg: 'Инсулин'
      ,hr: 'Količina iznulina'
      ,sv: 'Insulindos'
      }
    ,'Amount in grams' : {   
      cs: 'Množství v gramech'
      ,de: 'Menge in Gramm'
      ,es: 'Cantidad en gramos'
      ,fr: 'Quantité en grammes'
      ,pt: 'Quantidade em gramas'
      ,sv: 'Antal gram'
      ,ro: 'Cantitate în grame'
      ,bg: ' К-во в грамове'
      ,hr: 'Količina u gramima'
      }
    ,'Amount in units' : {   
      cs: 'Množství v jednotkách'
      ,de: 'Anzahl in Einheiten'
      ,es: 'Cantidad en unidades'
      ,fr: 'Quantité en unités'
      ,pt: 'Quantidade em unidades'
      ,ro: 'Cantitate în unități'
      ,bg: 'К-во в единици'
      ,hr: 'Količina u jedinicama'
      ,sv: 'Antal enheter'
      }
    ,'View all treatments' : {   
      cs: 'Zobraz všechny ošetření'
      ,de: 'Zeige alle Eingaben'
      ,es: 'Visualizar todos los tratamientos'
      ,fr: 'Voir tous les traitements'
      ,pt: 'Visualizar todos os tratamentos'
      ,sv: 'Visa behandlingar'
      ,ro: 'Vezi toate evenimentele'
      ,bg: 'Преглед на всички събития'
      ,hr: 'Prikaži sve tretmane'
      }
    ,'Enable Alarms' : {   
      cs: 'Povolit alarmy'
      ,de: 'Alarm einschalten'
      ,es: 'Activar las alarmas'
      ,fr: 'Activer les alarmes'
      ,pt: 'Ativar alarmes'
      ,ro: 'Activează alarmele'
      ,bg: 'Активни аларми'
      ,hr: 'Aktiviraj alarme'
      }
    ,'When enabled an alarm may sound.' : {   
      cs: 'Při povoleném alarmu zní zvuk'
      ,de: 'Sofern eingeschaltet ertönt ein Alarm'
      ,es: 'Cuando estén activas, una alarma podrá sonar'
      ,fr: 'Si activée, un alarme peut sonner.'
      ,pt: 'Quando ativado, um alarme poderá soar'
      ,ro: 'Când este activ, poate suna o alarmă.'
      ,bg: 'Когато е активирано, алармата ще има звук'
      ,hr: 'Kad je aktiviran, alarm se može oglasiti'
      }
    ,'Urgent High Alarm' : {   
      cs: 'Urgentní vysoká glykémie'
      ,de: 'Achtung Hoch Alarm'
      ,es: 'Alarma de glucemia alta urgente'
      ,fr: 'Alarme haute urgente'
      ,pt: 'Alarme de alto urgente'
      ,ro: 'Alarmă urgentă hiper'
      ,bg: 'Много висока КЗ'
      ,hr: 'Hitni alarm za hiper'
      }
    ,'High Alarm' : {   
      cs: 'Vysoká glykémie'
      ,de: 'Hoch Alarm'
      ,es: 'Alarma de glucemia alta'
      ,fr: 'Alarme haute'
      ,pt: 'Alarme de alto'
      ,ro:  'Alarmă hiper'
      ,bg: 'Висока КЗ'
      ,hr: 'Alarm za hiper'
      }
    ,'Low Alarm' : {   
      cs: 'Nízká glykémie'
      ,de: 'Tief Alarm'
      ,es: 'Alarma de glucemia baja'
      ,fr: 'Alarme basse'
      ,pt: 'Alarme de baixo'
      ,ro: 'Alarmă hipo'
      ,bg: 'Ниска КЗ'
      ,hr: 'Alarm za hipo'
      }
    ,'Urgent Low Alarm' : {   
      cs: 'Urgentní nízká glykémie'
      ,de: 'Achtung Tief Alarm'
      ,es: 'Alarma de glucemia baja urgente'
      ,fr: 'Alarme basse urgente'
      ,pt: 'Alarme de baixo urgente'
      ,ro: 'Alarmă urgentă hipo'
      ,bg: 'Много ниска КЗ'
      ,hr: 'Hitni alarm za hipo'
      }
    ,'Stale Data: Warn' : {   
      cs: 'Zastaralá data'
      ,de: 'Warnung: Daten nicht mehr gültig'
      ,es: 'Datos obsoletos: aviso'
      ,fr: 'Données dépassées: avis'
      ,pt: 'Dados antigos: aviso'
      ,ro: 'Date învechite: alertă'
      ,bg: 'Стари данни'
      ,hr: 'Pažnja: Stari podaci'
      }
    ,'Stale Data: Urgent' : {   
      cs: 'Zastaralá data urgentní'
      ,de: 'Achtung: Daten nicht mehr gültig'
      ,es: 'Datos obsoletos: Urgente'
      ,fr: 'Données dépassées urgentes'
      ,pt: 'Dados antigos: Urgente'
      ,sv: 'Brådskande varning, Inaktuell data'
      ,ro: 'Date învechite: urgent'
      ,bg: 'Много стари данни'
      ,hr: 'Hitno: Stari podaci'
      }
    ,'mins' : {   
      cs: 'min'
      ,de: 'min'
      ,es: 'min'
      ,fr: 'mins'
      ,pt: 'min'
      ,sv: 'min'
      ,ro: 'min'
      ,bg: 'мин'
      ,hr: 'min'
      }
    ,'Night Mode' : {   
      cs: 'Noční mód'
      ,de: 'Nacht Modus'
      ,es: 'Modo nocturno'
      ,fr: 'Mode nocturne'
      ,pt: 'Modo noturno'
      ,sv: 'Nattläge'
      ,ro: 'Mod nocturn'
      ,bg: 'Нощен режим'
      ,hr: 'Noćni način'
      }
    ,'When enabled the page will be dimmed from 10pm - 6am.' : {   
      cs: 'Když je povoleno, obrazovka je ztlumena 22:00 - 6:00'
      ,de: 'Wenn aktiviert wird die Anzeige von 22 Uhr - 6 Uhr gedimmt'
      ,es: 'Cuando esté activo, el brillo de la página bajará de 10pm a 6am.'
      ,fr: 'Si activé, la page sera assombire de 22:00 à 6:00'
      ,pt: 'Se ativado, a página será escurecida de 22h a 6h'
      ,ro: 'La activare va scădea iluminarea între 22 și 6'
      ,bg: 'Когато е активирано, страницата ще е затъмнена от 22-06ч'
      ,hr: 'Kad je uključen, stranica će biti zatamnjena od 22-06'
      }
    ,'Enable' : {   
      cs: 'Povoleno'
      ,de: 'Eingeschaltet'
      ,es: 'Activar'
      ,fr: 'Activer'
      ,pt: 'Ativar'
      ,sv: 'Aktivera'
      ,ro: 'Activează'
      ,bg: 'Активно'
      ,hr: 'Aktiviraj'
      }
    ,'Show Raw BG Data' : {
      cs: 'Zobraz RAW data'
      ,de: 'Zeige Roh-Blutglukose Daten'
      ,es: 'Mostrat datos en glucemia en crudo'
      ,fr: 'Montrer les données BG brutes'
      ,pt: 'Mostrar dados de glicemia não processados'
      ,ro: 'Afișează date primare glicemie'
      ,bg: 'Показвай RAW данни'
      ,hr: 'Prikazuj sirove podatke o GUK-u'
      ,sv: 'Visa RAW-data'
      }
    ,'Never' : {   
      cs: 'Nikdy'
      ,de: 'Nie'
      ,es: 'Nunca'
      ,fr: 'Jamais'
      ,pt: 'Nunca'
      ,sv: 'Aldrig'
      ,ro: 'Niciodată'
      ,bg: 'Никога'
      ,hr: 'Nikad'
      }
    ,'Always' : {   
      cs: 'Vždy'
      ,de: 'Immer'
      ,es: 'Siempre'
      ,fr: 'Toujours'
      ,pt: 'Sempre'
      ,sv: 'Alltid'
      ,ro: 'Întotdeauna'
      ,bg: 'Винаги'
      ,hr: 'Uvijek'
      }
    ,'When there is noise' : {   
      cs: 'Při šumu'
      ,de: 'Sofern Störgeräusch vorhanden'
      ,es: 'Cuando hay ruido'
      ,fr: 'Quand il y a du bruit'
      ,pt: 'Quando houver ruído'
      ,sv: 'Endast vid brus'
      ,ro: 'Atunci când este diferență'
      ,bg: 'Когато има шум'
      ,hr: 'Kad postoji šum'
      }
    ,'When enabled small white dots will be disaplyed for raw BG data' : {   
      cs: 'Když je povoleno, malé tečky budou zobrazeny pro RAW data'
      ,de: 'Bei Aktivierung erscheinen kleine weiße Punkte für Roh-Blutglukose Daten'
      ,es: 'Cuando esté activo, pequeños puntos blancos mostrarán los datos en crudo'
      ,fr: 'Si activé, des points blancs représenteront les données brutes'
      ,pt: 'Se ativado, pontinhos brancos representarão os dados de glicemia não processados'
      ,ro: 'La activare vor apărea puncte albe reprezentând citirea brută a glicemiei'
      ,bg: 'Когато е активирано, малки бели точки ще показват RAW данните'
      ,hr: 'Kad je omogućeno, male bijele točkice će prikazivati sirove podatke o GUK-u.'
      }
    ,'Custom Title' : {   
      cs: 'Vlastní název stránky'
      ,de: 'Benutzerdefiniert'
      ,es: 'Título personalizado'
      ,fr: 'Titre sur mesure'
      ,pt: 'Customizar Título'
      ,sv: 'Egen titel'
      ,ro: 'Titlu particularizat'
      ,bg: 'Име на страницата'
      ,hr: 'Vlastiti naziv'
      }
    ,'Theme' : {   
      cs: 'Téma'
      ,de: 'Thema'
      ,es: 'Tema'
      ,fr: 'Thème'
      ,pt: 'tema'
      ,ro: 'Temă'
      ,bg: 'Тема'
      ,hr: 'Tema'
      ,sv: 'Tema'
      }
    ,'Default' : {   
      cs: 'Výchozí'
      ,de: 'Voreingestellt'
      ,es: 'Por defecto'
      ,fr: 'Par défaut'
      ,pt: 'Padrão'
      ,ro: 'Implicită'
      ,bg: 'Черно-бяла'
      ,hr: 'Default'
      ,sv: 'Standard'
      }
    ,'Colors' : {   
      cs: 'Barevné'
      ,de: 'Farben'
      ,es: 'Colores'
      ,fr: 'Couleurs'
      ,pt: 'Cores'
      ,ro: 'Colorată'
      ,bg: 'Цветна'
      ,hr: 'Boje'
      }
    ,'Reset, and use defaults' : {   
      cs: 'Vymaž a nastav výchozí hodnoty'
      ,de: 'Zurücksetzen und Voreinstellungen verwenden'
      ,es: 'Inicializar y utilizar los valores por defecto'
      ,fr: 'Remise à zéro et utiliser des valeurs par défaut'
      ,pt: 'Zerar e usar padrões'
      ,sv: 'Återställ standardvärden'
      ,ro: 'Resetează și folosește setările implicite'
      ,bg: 'Нулирай и използвай стандартните настройки'
      ,hr: 'Resetiraj i koristi defaultne vrijednosti'
      }
    ,'Calibrations' : {   
      cs: 'Kalibrace'
      ,de: 'Kalibrierung'
      ,es: 'Calibraciones'
      ,fr: 'Calibration'
      ,pt: 'Calibraçôes'
      ,ro: 'Calibrări'
      ,bg: 'Калибрации'
      ,hr: 'Kalibriranje'
      }
    ,'Alarm Test / Smartphone Enable' : {   
      cs: 'Test alarmu'
      ,de: 'Alarm Test / Smartphone aktivieren'
      ,es: 'Test de Alarma / Activar teléfono'
      ,fr: 'Test alarme / Activer Smartphone'
      ,pt: 'Testar Alarme / Ativar Smartphone'
      ,ro: 'Teste alarme / Activează pe smartphone'
      ,bg: 'Тестване на алармата / Активно за мобилни телефони'
      ,hr: 'Alarm test / Aktiviraj smartphone'
      }
    ,'Bolus Wizard' : {   
      cs: 'Bolusový kalkulátor'
      ,de: 'Bolus Kalkulator'
      ,es: 'Bolus Wizard'
      ,fr: 'Calculateur de bolus'
      ,pt: 'Bolus Wizard'
      ,sv: 'Boluskalkylator'
      ,ro: 'Calculator sugestie bolus'
      ,bg: 'Съветник при изчисление на болуса'
      ,hr: 'Bolus wizard'
      }
    ,'in the future' : {   
      cs: 'v budoucnosti'
      ,de: 'in der Zuknft'
      ,es: 'en el futuro'
      ,fr: 'dans le futur'
      ,pt: 'no futuro'
      ,sv: 'framtida'
      ,ro: 'în viitor'
      ,bg: 'в бъдещето'
      ,hr: 'U budućnosti'
      }
    ,'time ago' : {   
      cs: 'min zpět'
      ,de: 'Aktualisiert'
      ,es: 'tiempo atrás'
      ,fr: 'temps avant'
      ,pt: 'tempo atrás'
      ,sv: 'tid sedan'
      ,ro: 'în trecut'
      ,bg: 'преди време'
      ,hr: 'prije'
      }
    ,'hr ago' : {   
      cs: 'hod zpět'
      ,de: 'Std. vorher'
      ,es: 'hr atrás'
      ,fr: 'hr avant'
      ,pt: 'h atrás'
      ,ro: 'oră în trecut'
      ,bg: 'час по-рано'
      ,hr: 'sat unazad'
      }
    ,'hrs ago' : {   
      cs: 'hod zpět'
      ,de: 'Std. vorher'
      ,es: 'hr atrás'
      ,fr: 'hrs avant'
      ,pt: 'h atrás'
      ,sv: 'Timmar sedan'
      ,ro: 'h în trecut'
      ,bg: 'часа по-рано'
      ,hr: 'sati unazad'
      }
    ,'min ago' : {   
      cs: 'min zpět'
      ,de: 'Min. vorher'
      ,es: 'min atrás'
      ,fr: 'min avant'
      ,pt: 'min atrás'
      ,sv: 'minut sedan'
      ,ro: 'minut în trecut'
      ,bg: 'минута по-рано'
      ,hr: 'minuta unazad'
      }
    ,'mins ago' : {   
      cs: 'min zpět'
      ,de: 'Min. vorher'
      ,es: 'min atrás'
      ,fr: 'mins avant'
      ,pt: 'min atrás'
      ,sv: 'minuter sedan'
      ,ro: 'minute în trecut'
      ,bg: 'минути по-рано'
      ,hr: 'minuta unazad'
      }
    ,'day ago' : {   
      cs: 'den zpět'
      ,de: 'Tag vorher'
      ,es: 'día atrás'
      ,fr: 'jour avant'
      ,pt: 'dia atrás'
      ,sv: 'dag sedan'
      ,ro: 'zi în trecut'
      ,bg: 'ден по-рано'
      ,hr: 'dan unazad'
      }
    ,'days ago' : {   
      cs: 'dnů zpět'
      ,de: 'Tage vorher'
      ,es: 'días atrás'
      ,fr: 'jours avant'
      ,pt: 'dias atrás'
      ,sv: 'dagar sedan'
      ,ro: 'zile în trecut'
      ,bg: 'дни по-рано'
      ,hr: 'dana unazad'
      }
    ,'long ago' : {   
      cs: 'dlouho zpět'
      ,de: 'Lange her'
      ,es: 'Hace mucho tiempo'
      ,fr: 'il y a longtemps'
      ,pt: 'muito tempo atrás'
      ,sv: 'länge sedan'
      ,ro: 'timp în trecut'
      ,bg: 'преди много време'
      ,hr: 'prije dosta vremena'
      }
    ,'Clean' : {   
      cs: 'Čistý'
      ,de: 'Komplett'
      ,es: 'Limpio'
      ,fr: 'Propre'
      ,pt: 'Limpo'
      ,sv: 'Rent'
      ,ro: 'Curat'
      ,bg: 'Чист'
      ,hr: 'Čisto'
      }
    ,'Light' : {   
      cs: 'Lehký'
      ,de: 'Leicht'
      ,es: 'Ligero'
      ,fr: 'Léger'
      ,pt: 'Leve'
      ,sv: 'Lätt'
      ,ro: 'Ușor'
      ,bg: 'Лек'
      ,hr: 'Lagano'
      }
    ,'Medium' : {   
      cs: 'Střední'
      ,de: 'Mittel'
      ,es: 'Medio'
      ,fr: 'Moyen'
      ,pt: 'Médio'
      ,sv: 'Måttligt'
      ,ro: 'Mediu'
      ,bg: 'Среден'
      ,hr: 'Srednje'
      }
    ,'Heavy' : {   
      cs: 'Velký'
      ,de: 'Schwer'
      ,es: 'Fuerte'
      ,fr: 'Important'
      ,pt: 'Pesado'
      ,sv: 'Rikligt'
      ,ro: 'Puternic'
      ,bg: 'Висок'
      ,hr: 'Teško'
      }
    ,'Treatment type' : {   
      cs: 'Typ ošetření'
      ,de: 'Eingabe Typ'
      ,es: 'Tipo de tratamiento'
      ,fr: 'Type de traitement'
      ,pt: 'Tipo de tratamento'
      ,sv: 'Behandlingstyp'
      ,ro: 'Tip tratament'
      ,bg: 'Вид събитие'
      ,hr: 'Vrsta tretmana'
      }
    ,'Raw BG' : {   
      cs: 'Glykémie z RAW dat'
      ,de: 'Roh Blutglukose'
      ,es: 'Glucemia en crudo'
      ,fr: 'Glycémie brut'
      ,pt: 'Glicemia sem processamento'
      ,sv: 'RAW-BS'
      ,ro: 'Citire brută a glicemiei'
      ,bg: 'Непреработена КЗ'
      ,hr: 'Sirovi podaci o GUK-u'
      }
    ,'Device' : {   
      cs: 'Zařízení'
      ,de: 'Gerät'
      ,es: 'Dispositivo'
      ,fr: 'Appareil'
      ,pt: 'Dispositivo'
      ,sv: 'Device'
      ,ro: 'Dispozitiv'
      ,bg: 'Устройство'
      ,hr: 'Uređaj'
      }
    ,'Noise' : {   
      cs: 'Šum'
      ,de: 'Störgeräusch'
      ,es: 'Ruido'
      ,fr: 'Bruit'
      ,pt: 'Ruído'
      ,sv: 'Brus'
      ,ro: 'Zgomot'
      ,bg: 'Шум'
      ,hr: 'Šum'
      }
    ,'Calibration' : {   
      cs: 'Kalibrace'
      ,de: 'Kalibrierung'
      ,es: 'Calibración'
      ,fr: 'Calibration'
      ,pt: 'Calibração'
      ,sv: 'Kalibrering'
      ,ro: 'Calibrare'
      ,bg: 'Калибрация'
      ,hr: 'Kalibriranje'
      }
    ,'Show Plugins' : {   
      cs: 'Zobrazuj pluginy'
      ,de: 'Zeige Plugins'
      ,es: 'Mostrar Plugins'
      ,fr: 'Montrer Plugins'
      ,pt: 'Mostrar Plugins'
      ,ro: 'Arată plugin-urile'
      ,bg: 'Покажи добавките'
      ,hr: 'Prikaži plugine'
      }
    ,'About' : {   
      cs: 'O aplikaci'
      ,de: 'Über'
      ,es: 'Sobre'
      ,fr: 'À propos de'
      ,pt: 'Sobre'
      ,ro: 'Despre'
      ,bg: 'Относно'
      ,hr: 'O aplikaciji'
      ,sv: 'Om'
      }
    ,'Value in' : {   
      cs: 'Hodnota v'
      ,de: 'Wert in'
      ,es: 'Valor en'
      ,fr: 'Valeur en'
      ,pt: 'Valor em'
      ,ro: 'Valoare în'
      ,bg: 'Стойност в'
      ,hr: 'Vrijednost u'
      ,sv: 'Värde om'
      }
    ,'Carb Time' : {   
      cs: 'Čas jídla'
      ,de: 'Kohlenhydrate Zeit'
      ,es: 'Momento de la ingesta'
      ,fr: 'Moment de Glucide'
      ,bg: 'ВХ действа след'
      ,hr: 'Vrijeme unosa UH'
      ,sv: 'Kolhydratstid'
      }
 
 };
  
 language.translate = function translate(text) {
    if (translations[text] && translations[text][lang]) {
      return translations[text][lang];
    }
    return text;
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
    lang = newlang;
    return language();
  };
  
  return language();
}

module.exports = init;
