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
      ,ro: 'Activ pe portul'
      ,bg: 'Активиране на порта'
      }
    // Client
    ,'Mo' : {
      cs: 'Po'
      ,de: 'Mo'
      ,es: 'Lu'
      ,fr: 'Lu'
      ,pt: 'Seg'
      ,ro: 'Lu'
      ,bg: 'Пон'
      }
    ,'Tu' : {
      cs: 'Út'
      ,de: 'Di'
      ,es: 'Mar'
      ,fr: 'Ma'
      ,pt: 'Ter'
      ,ro: 'Ma'
      ,bg: 'Вт'
      },
    ',We' : {
      cs: 'St'
      ,de: 'Mi'
      ,es: 'Mie'
      ,fr: 'Me'
      ,pt: 'Qua'
      ,ro: 'Mie'
      ,bg: 'Ср'
      }
    ,'Th' : {
      cs: 'Čt'
      ,de: 'Do'
      ,es: 'Jue'
      ,fr: 'Je'
      ,pt: 'Qui'
      ,ro: 'Jo'
      ,bg: 'Четв'
      }
    ,'Fr' : {
      cs: 'Pá'
      ,de: 'Fr'
      ,es: 'Vie'
      ,fr: 'Ve'
      ,pt: 'Sex'
      ,ro: 'Vi'
      ,bg: 'Пет'
      }
    ,'Sa' : {
      cs: 'So'
      ,de: 'Sa'
      ,es: 'Sab'
      ,fr: 'Sa'
      ,pt: 'Sa'
      ,ro: 'Sa'
      ,bg: 'Съб'
      }
    ,'Su' : {
      cs: 'Ne'
      ,de: 'So'
      ,es: 'Dom'
      ,fr: 'Di'
      ,pt: 'Dom'
      ,ro: 'Du'
      ,bg: 'Нед'
      }
    ,'Monday' : {
      cs: 'Pondělí'
      ,de: 'Montag'
      ,es: 'Lunes'
      ,fr: 'Lundi'
      ,pt: 'Segunda'
      ,ro: 'Luni'
      ,bg: 'Понеделник'
      }
    ,'Tuesday' : {
      cs: 'Úterý'
      ,de: 'Dienstag'
      ,es: 'Martes'
      ,fr: 'Mardi'
      ,pt: 'Terça'
      ,ro: 'Marți'
      ,bg: 'Вторник'
      }
    ,'Wednesday' : {
      cs: 'Středa'
      ,de: 'Mittwoch'
      ,es: 'Miércoles'
      ,fr: 'Mercredi'
      ,pt: 'Quarta'
      ,ro: 'Miercuri'
      ,bg: 'Сряда'
      }
    ,'Thursday' : {
      cs: 'Čtvrtek'
      ,de: 'Donnerstag'
      ,es: 'Jueves'
      ,fr: 'Jeudi'
      ,pt: 'Quinta'
      ,ro: 'Joi'
      ,bg: 'Четвъртък'
      }
    ,'Friday' : {
      cs: 'Pátek'
      ,de: 'Freitag'
      ,fr: 'Vendredi'
      ,pt: 'Sexta'
      ,ro: 'Vineri'
      ,es: 'Viernes'
      ,bg: 'Петък'
      }
    ,'Saturday' : {
      cs: 'Sobota'
      ,de: 'Samstag'
      ,es: 'Sábado'
      ,fr: 'Samedi'
      ,pt: 'Sábado'
      ,ro: 'Sâmbătă'
      ,bg: 'Събота'
      }
    ,'Sunday' : {
      cs: 'Neděle'
      ,de: 'Sonntag'
      ,es: 'Domingo'
      ,fr: 'Dimanche'
      ,pt: 'Domingo'
      ,ro: 'Duminică'
      ,bg: 'Неделя'
      }
    ,'Category' : {
      cs: 'Kategorie'
      ,de: 'Kategorie'
      ,es: 'Categoría'
      ,fr: 'Catégorie'
      ,pt: 'Categoria'
      ,ro: 'Categorie'
      ,bg: 'Категория'
      }
    ,'Subcategory' : {   
      cs: 'Podkategorie'
      ,de: 'Unterkategorie'
      ,es: 'Subcategoría'
      ,fr: 'Sous-catégorie'
      ,pt: 'Subcategoria'
      ,ro: 'Subcategorie'
      ,bg: 'Подкатегория'
      }
    ,'Name' : {   
      cs: 'Jméno'
      ,de: 'Name'
      ,es: 'Nombre'
      ,fr: 'Nom'
      ,pt: 'Nome'
      ,ro: 'Nume'
      ,bg: 'Име'
      }
    ,'Today' : {   
      cs: 'Dnes'
      ,de: 'Heute'
      ,es: 'Hoy'
      ,fr: 'Aujourd\'hui'
      ,pt: 'Hoje'
      ,ro: 'Astăzi'
      ,bg: 'Днес'
      }
    ,'Last 2 days' : {   
      cs: 'Poslední 2 dny'
      ,de: 'letzten 2 Tage'
      ,es: 'Últimos 2 días'
      ,fr: '2 derniers jours'
      ,pt: 'Últimos 2 dias'
      ,ro: 'Ultimele 2 zile'
      }
    ,'Last 3 days' : {   
      cs: 'Poslední 3 dny'
      ,de: 'letzten 3 Tage'
      ,es: 'Últimos 3 días'
      ,fr: '3 derniers jours'
      ,pt: 'Últimos 3 dias'
      ,ro: 'Ultimele 3 zile'
      }
    ,'Last week' : {   
      cs: 'Poslední týden'
      ,de: 'letzte Woche'
      ,es: 'Semana pasada'
      ,fr: 'Semaine Dernière'
      ,pt: 'Semana passada'
      ,ro: 'Săptămâna trecută'
      }
    ,'Last 2 weeks' : {   
      cs: 'Poslední 2 týdny'
      ,de: 'letzten 2 Wochen'
      ,es: 'Últimas 2 semanas'
      ,fr: '2 dernières semaines'
      ,pt: 'Últimas 2 semanas'
      ,ro: 'Ultimele 2 săptămâni'
      }
    ,'Last month' : {   
      cs: 'Poslední měsíc'
      ,de: 'letzter Monat'
      ,es: 'Mes pasado'
      ,fr: 'Mois dernier'
      ,pt: 'Mês passado'
      ,ro: 'Ultima lună'
      }
    ,'Last 3 months' : {   
      cs: 'Poslední 3 měsíce'
      ,de: 'letzten 3 Monate'
      ,es: 'Últimos 3 meses'
      ,fr: '3 derniers mois'
      ,pt: 'Últimos 3 meses'
      ,ro: 'Ultimele 3 luni'
      }
    ,'From' : {   
      cs: 'Od'
      ,de: 'Von'
      ,es: 'Desde'
      ,fr: 'De'
      ,pt: 'De'
      ,ro: 'De la'
      }
    ,'To' : {   
      cs: 'Do'
      ,de: 'Bis'
      ,es: 'Hasta'
      ,fr: 'à'
      ,pt: 'Para'
      ,ro: 'La'
      }
    ,'Notes' : {   
      cs: 'Poznámky'
      ,de: 'Notiz'
      ,es: 'Notas'
      ,fr: 'Notes'
      ,pt: 'Notas'
      ,ro: 'Note'
      }
    ,'Food' : {   
      cs: 'Jídlo'
      ,de: 'Essen'
      ,es: 'Comida'
      ,fr: 'Nourriture'
      ,pt: 'Comida'
      ,ro: 'Mâncare'
      }
    ,'Insulin' : {   
      cs: 'Inzulín'
      ,de: 'Insulin'
      ,es: 'Insulina'
      ,fr: 'Insuline'
      ,pt: 'Insulina'
      ,ro: 'Insulină'
      }
    ,'Carbs' : {   
      cs: 'Sacharidy'
      ,de: 'Kohlenhydrate'
      ,es: 'Hidratos de carbono'
      ,fr: 'Glucides'
      ,pt: 'Carboidrato'
      ,ro: 'Carbohidrați'
      }
    ,'Notes contain' : {   
      cs: 'Poznámky obsahují'
      ,de: 'Erläuterungen'
      ,es: 'Contenido de las notas'
      ,fr: 'Notes contiennent'
      ,pt: 'Notas contém'
      ,ro: 'Conținut note'
      }
    ,'Event type contains' : {   
      cs: 'Typ události obsahuje'
      ,de: 'Ereignis-Typ beinhaltet'
      ,es: 'Contenido del tipo de evento'
      ,fr: 'Type d\'événement contient'
      ,pt: 'Tipo de evento contém'
      ,ro: 'Conținut tip de eveniment'
      }
    ,'Target bg range bottom' : {   
      cs: 'Cílová glykémie spodní'
      ,de: 'Untergrenze des Blutzuckerzielbereiches'
      ,es: 'Objetivo inferior de glucemia'
      ,fr: 'Limite inférieure glycémie'
      ,pt: 'Limite inferior de glicemia'
      ,ro: 'Limită de jos a glicemiei'
      }
    ,'top' : {   
      cs: 'horní'
      ,de: 'oben'
      ,es: 'Superior'
      ,fr: 'Supérieur'
      ,pt: 'Superior'
      ,ro: 'Sus'
      }
    ,'Show' : {   
      cs: 'Zobraz'
      ,de: 'Zeigen'
      ,es: 'Mostrar'
      ,fr: 'Montrer'
      ,pt: 'Mostrar'
      ,ro: 'Arată'
      }
    ,'Display' : {   
      cs: 'Zobraz'
      ,de: 'Darstellen'
      ,es: 'Visualizar'
      ,fr: 'Afficher'
      ,pt: 'Mostrar'
      ,ro: 'Afișează'
      }
    ,'Loading' : {   
      cs: 'Nahrávám'
      ,de: 'Laden'
      ,es: 'Cargando'
      ,fr: 'Chargement'
      ,pt: 'Carregando'
      ,ro: 'Se încarcă'
      }
    ,'Loading profile' : {   
      cs: 'Nahrávám profil'
      ,de: 'Lade Profil'
      ,es: 'Cargando perfil'
      ,fr: 'Chargement du profil'
      ,pt: 'Carregando perfil'
      ,ro: 'Încarc profilul'
      }
    ,'Loading status' : {   
      cs: 'Nahrávám status'
      ,de: 'Lade Status'
      ,es: 'Cargando estado'
      ,fr: 'Statut du chargement'
      ,pt: 'Carregando status'
      ,ro: 'Încarc statusul'
      }
    ,'Loading food database' : {   
      cs: 'Nahrávám databázi jídel'
      ,de: 'Lade Nahrungsmittel-Datenbank'
      ,es: 'Cargando base de datos de alimentos'
      ,fr: 'Chargement de la base de données alimentaire'
      ,pt: 'Carregando dados de alimentos'
      ,ro: 'Încarc baza de date de alimente'
      }
    ,'not displayed' : {   
      cs: 'není zobrazeno'
      ,de: 'nicht angezeigt'
      ,es: 'No mostrado'
      ,fr: 'non affiché'
      ,pt: 'não mostrado'
      ,ro: 'neafișat'
      }
    ,'Loading CGM data of' : {   
      cs: 'Nahrávám CGM data'
      ,de: 'Lade CGM-Daten von'
      ,es: 'Cargando datos de CGM de'
      ,fr: 'Chargement données CGM de'
      ,pt: 'Carregando dados de CGM de'
      ,ro: 'Încarc datele CGM ale lui'
      }
    ,'Loading treatments data of' : {   
      cs: 'Nahrávám data ošetření'
      ,de: 'Lade Behandlungsdaten von'
      ,es: 'Cargando datos de tratamientos de'
      ,fr: 'Chargement données traitement de'
      ,pt: 'Carregando dados de tratamento de'
      ,ro: 'Încarc datele despre tratament pentru'
      }
    ,'Processing data of' : {   
      cs: 'Zpracovávám data'
      ,de: 'Verarbeite Daten von'
      ,es: 'Procesando datos de'
      ,fr: 'Traitement des données de'
      ,pt: 'Processando dados de'
      ,ro: 'Procesez datele lui'
      }
    ,'Portion' : {   
      cs: 'Porce'
      ,de: 'Portion'
      ,es: 'Porción'
      ,fr: 'Portion'
      ,pt: 'Porção'
      ,ro: 'Porție'
      }
    ,'Size' : {   
      cs: 'Rozměr'
      ,de: 'Größe'
      ,es: 'Tamaño'
      ,fr: 'Taille'
      ,pt: 'Tamanho'
      ,ro: 'Mărime'
      }
    ,'(none)' : {   
      cs: '(Prázdný)'
      ,de: '(nichts)'
      ,es: '(ninguno)'
      ,fr: '(aucun)'
      ,pt: '(nenhum)'
      ,ro: '(fără)'
      }
    ,'Result is empty' : {   
      cs: 'Prázdný výsledek'
      ,de: 'Leeres Ergebnis'
      ,es: 'Resultado vacío'
      ,fr: 'Pas de résultat'
      ,pt: 'Resultado vazio'
      ,ro: 'Fără rezultat'
      }
// ported reporting
    ,'Day to day' : {   
      cs: 'Den po dni'
      ,de: 'Von Tag zu Tag'
      ,es: 'Día a día'
      ,fr: 'jour par jour'
      ,pt: 'Dia a dia'
      ,ro: 'Zi cu zi'
      }
    ,'Daily Stats' : {   
      cs: 'Denní statistiky'
      ,de: 'Tägliche Statistik'
      ,es: 'Estadísticas diarias'
      ,fr: 'Stats quotidiennes'
      ,pt: 'Estatísticas diárias'
      ,ro: 'Statistici zilnice'
      }
    ,'Percentile Chart' : {   
      cs: 'Percentil'
      ,de: 'Durchschnittswert'
      ,es: 'Percentiles'
      ,fr: 'Percentiles'
      ,pt: 'Percentis'
      ,ro: 'Grafic percentile'
      }
    ,'Distribution' : {   
      cs: 'Rozložení'
      ,de: 'Streuung'
      ,es: 'Distribución'
      ,fr: 'Distribution'
      ,pt: 'Distribuição'
      ,ro: 'Distribuție'
	  }
    ,'Hourly stats' : {   
      cs: 'Statistika po hodinách'
      ,de: 'Stündliche Statistik'
      ,es: 'Estadísticas por hora'
      ,fr: 'Statistiques horaires'
      ,pt: 'Estatísticas por hora'
      ,ro: 'Statistici orare'
	  }
    ,'Weekly success' : {   
      cs: 'Statistika po týdnech'
      ,de: 'Wöchentlicher Erfolg'
      ,es: 'Resultados semanales'
      ,fr: 'Résultat hebdomadaire'
      ,pt: 'Resultados semanais'
      ,ro: 'Rezultate săptămânale'
      }
    ,'No data available' : {   
      cs: 'Žádná dostupná data'
      ,de: 'Keine Daten verfügbar'
      ,es: 'No hay datos disponibles'
      ,fr: 'Pas de données disponibles'
      ,pt: 'não há dados'
      ,ro: 'Fără date'
      }
    ,'Low' : {   
      cs: 'Nízká'
      ,de: 'Tief'
      ,es: 'Bajo'
      ,fr: 'Bas'
      ,pt: 'Baixo'
      ,ro: 'Prea jos'
      }
    ,'In Range' : {   
      cs: 'V rozsahu'
      ,de: 'Im Zielbereich'
      ,es: 'En rango'
      ,fr: 'dans la norme'
      ,pt: 'Na meta'
      ,ro: 'În interval'
      }
    ,'Period' : {   
      cs: 'Období'
      ,de: 'Zeitraum'
      ,es: 'Periodo'
      ,fr: 'Période'
      ,pt: 'Período'
      ,ro: 'Perioada'
      }
    ,'High' : {   
      cs: 'Vysoká'
      ,de: 'Hoch'
      ,es: 'Alto'
      ,fr: 'Haut'
      ,pt: 'Alto'
      ,ro: 'Prea sus'
      }
    ,'Average' : {   
      cs: 'Průměrná'
      ,de: 'Mittelwert'
      ,es: 'Media'
      ,fr: 'Moyenne'
      ,pt: 'Média'
      ,ro: 'Media'
      }
    ,'Low Quartile' : {   
      cs: 'Nízký kvartil'
      ,de: 'Unteres Quartil'
      ,es: 'Cuartil inferior'
      ,fr: 'Quartile inférieur'
      ,pt: 'Quartil inferior'
      ,ro: 'Pătrime inferioară'
      }
    ,'Upper Quartile' : {   
      cs: 'Vysoký kvartil'
      ,de: 'Oberes Quartil'
      ,es: 'Cuartil superior'
      ,fr: 'Quartile supérieur'
      ,pt: 'Quartil superior'
      ,ro: 'Pătrime superioară'
      }
    ,'Quartile' : {   
      cs: 'Kvartil'
      ,de: 'Quartil'
      ,es: 'Cuartil'
      ,fr: 'Quartile'
      ,pt: 'Quartil'
      ,ro: 'Pătrime'
      }
    ,'Date' : {   
      cs: 'Datum'
      ,de: 'Datum'
      ,es: 'Fecha'
      ,fr: 'Date'
      ,pt: 'Data'
      ,ro: 'Data'
      }
    ,'Normal' : {   
      cs: 'Normální'
      ,de: 'Normal'
      ,es: 'Normal'
      ,fr: 'Normale'
      ,pt: 'Normal'
      ,ro: 'Normal'
      }
    ,'Median' : {   
      cs: 'Medián'
      ,de: 'Median'
      ,es: 'Mediana'
      ,fr: 'Médiane'
      ,pt: 'Mediana'
      ,ro: 'Mediană'
      }
    ,'Readings' : {   
      cs: 'Záznamů'
      ,de: 'Messwerte'
      ,es: 'Valores'
      ,fr: 'Valeurs'
      ,pt: 'Valores'
      ,ro: 'Valori'
      }
    ,'StDev' : {   
      cs: 'St. odchylka'
      ,de: 'Standardabweichung'
      ,es: 'Desviación estándar'
      ,fr: 'Déviation St.'
      ,pt: 'DesvPadr'
      ,ro: 'Dev Std'
      }
    ,'Daily stats report' : {   
      cs: 'Denní statistiky'
      ,de: 'Tagesstatistik Bericht'
      ,es: 'Informe de estadísticas diarias'
      ,fr: 'Rapport quotidien'
      ,pt: 'Relatório diário'
      ,ro: 'Raport statistică zilnică'
      }
    ,'Glucose Percentile report' : {   
      cs: 'Tabulka percentil glykémií'
      ,de: 'Glukose-Prozent Bericht'
      ,es: 'Informe de percetiles de glucemia'
      ,fr: 'Rapport precentiles Glycémie'
      ,pt: 'Relatório de Percentis de Glicemia'
      ,ro: 'Raport percentile glicemii'
      }
    ,'Glucose distribution' : {   
      cs: 'Rozložení glykémií'
      ,de: 'Glukuse Verteilung'
      ,es: 'Distribución de glucemias'
      ,fr: 'Distribution glycémies'
      ,pt: 'Distribuição de glicemias'
      ,ro: 'Distribuție glicemie'
      }
    ,'days total' : {   
      cs: 'dní celkem'
      ,de: 'Gesamttage'
      ,es: 'Total de días'
      ,fr: 'jours totaux'
      ,pt: 'dias total'
      ,ro: 'total zile'
      }
    ,'Overall' : {   
      cs: 'Celkem'
      ,de: 'Insgesamt'
      ,es: 'General'
      ,fr: 'Dans l\'ensemble'
      ,pt: 'Geral'
      ,ro: 'General'
      }
    ,'Range' : {   
      cs: 'Rozsah'
      ,de: 'Bereich'
      ,es: 'Intervalo'
      ,fr: 'Intervalle'
      ,pt: 'intervalo'
      ,ro: 'Interval'
      }
    ,'% of Readings' : {   
      cs: '% záznamů'
      ,de: '% der Messwerte'
      ,es: '% de valores'
      ,pt: '% de valores'
      ,ro: '% de valori'
      }
    ,'# of Readings' : {   
      cs: 'počet záznamů'
      ,de: '# der Messwerte'
      ,es: 'N° de valores'
      ,fr: 'nbr de valeurs'
      ,pt: 'N° de valores'
      ,ro: 'nr. de valori'
      }
    ,'Mean' : {   
      cs: 'Střední hodnota'
      ,de: 'Durchschnittlich'
      ,es: 'Media'
      ,fr: 'Moyenne'
      ,pt: 'Média'
      ,ro: 'Medie'
      }
    ,'Standard Deviation' : {   
      cs: 'Standardní odchylka'
      ,de: 'Standardabweichung'
      ,es: 'Desviación estándar'
      ,fr: 'Déviation Standard'
      ,pt: 'Desvio padrão'
      ,ro: 'Deviație standard'
      }
    ,'Max' : {   
      cs: 'Max'
      ,de: 'Max'
      ,es: 'Max'
      ,fr: 'Max'
      ,pt: 'Max'
      ,ro: 'Max'
      }
    ,'Min' : {   
      cs: 'Min'
      ,de: 'Min'
      ,es: 'Min'
      ,fr: 'Min'
      ,pt: 'Min'
      ,ro: 'Min'
      }
    ,'A1c estimation*' : {   
      cs: 'Předpokládané HBA1c*'
      ,de: 'Prognose HbA1c*'
      ,es: 'Estimación de HbA1c*'
      ,fr: 'Estimation HbA1c*'
      ,pt: 'A1c estimada'
      ,ro: 'HbA1C estimată'
      }
    ,'Weekly Success' : {   
      cs: 'Týdenní úspěšnost'
      ,de: 'Wöchtlicher Erfolg'
      ,es: 'Resultados semanales'
      ,fr: 'Réussite hebdomadaire'
      ,pt: 'Resultados semanais'
      ,ro: 'Rezultate săptămânale'
      }
    ,'There is not sufficient data to run this report. Select more days.' : {   
      cs: 'Není dostatek dat. Vyberte delší časové období.'
      ,de: 'Für diesen Bericht sind nicht genug Daten verfügbar. Bitte weitere Tage auswählen'
      ,es: 'No hay datos suficientes para generar este informe. Seleccione más días.'
      ,fr: 'Pas assez de données pour un rapport. Sélectionnez plus de jours.'
      ,pt: 'Não há dados suficientes. Selecione mais dias'
      ,ro: 'Nu sunt sufieciente date pentru acest raport. Selectați mai multe zile.'
	  }
// food editor
    ,'Using stored API secret hash' : {   
      cs: 'Používám uložený hash API hesla'
      ,de: 'Gespeicherte API-Prüfsumme verwenden'
      ,es: 'Usando el hash del API pre-almacenado'
      ,fr: 'Utilisation du hash API existant'
      ,pt: 'Usando o hash de API existente'
      ,ro: 'Utilizez cheie API secretă'
      }
    ,'No API secret hash stored yet. You need to enter API secret.' : {   
      cs: 'Není uložený žádný hash API hesla. Musíte zadat API heslo.'
      ,de: 'Keine API-Prüfsumme gespeichert. Bitte API-Prüfsumme eingeben.'
      ,es: 'No se ha almacenado ningún hash todavía. Debe introducir su secreto API.'
      ,fr: 'Pas de secret API existant. Vous devez en entrer un.'
      ,pt: 'Hash de segredo de API inexistente. Entre um segredo de API'
      ,ro: 'Încă nu există cheie API secretă. Aceasta trebuie introdusă.'
      }
    ,'Database loaded' : {   
      cs: 'Databáze načtena'
      ,de: 'Datenbank geladen'
      ,es: 'Base de datos cargada'
      ,fr: 'Base de données chargée'
      ,pt: 'Banco de dados carregado'
      ,ro: 'Baza de date încărcată'
      }
    ,'Error: Database failed to load' : {   
      cs: 'Chyba při načítání databáze'
      ,de: 'Fehler: Datenbank konnte nicht geladen werden'
      ,es: 'Error: Carga de base de datos fallida'
      ,fr: 'Erreur, le chargement de la base de données a échoué'
      ,pt: 'Erro: Banco de dados não carregado'
      ,ro: 'Eroare: Nu s-a încărcat baza de date'
      }
    ,'Create new record' : {   
      cs: 'Vytvořit nový záznam'
      ,de: 'Erstelle neuen Datensatz'
      ,es: 'Crear nuevo registro'
      ,fr: 'Créer nouvel enregistrement'
      ,pt: 'Criar novo registro'
      ,ro: 'Crează înregistrare nouă'
      }
    ,'Save record' : {   
      cs: 'Uložit záznam'
      ,de: 'Speichere Datensatz'
      ,es: 'Guardar registro'
      ,fr: 'Sauver enregistrement'
      ,pt: 'Salvar registro'
      ,ro: 'Salvează înregistrarea'
      }
    ,'Portions' : {   
      cs: 'Porcí'
      ,de: 'Portionen'
      ,es: 'Porciones'
      ,fr: 'Portions'
      ,pt: 'Porções'
      ,ro: 'Porții'
      }
    ,'Unit' : {   
      cs: 'Jedn'
      ,de: 'Einheit'
      ,es: 'Unidades'
      ,fr: 'Unités'
      ,pt: 'Unidade'
      ,ro: 'Unități'
      }
    ,'GI' : {   
      cs: 'GI'
      ,de: 'GI'
      ,es: 'IG'
      ,fr: 'IG'
      ,pt: 'IG'
      ,ro: 'CI'
      }
    ,'Edit record' : {   
      cs: 'Upravit záznam'
      ,de: 'Bearbeite Datensatz'
      ,es: 'Editar registro'
      ,fr: 'Modifier enregistrement'
      ,pt: 'Editar registro'
      ,ro: 'Editează înregistrarea'
      }
    ,'Delete record' : {   
      cs: 'Smazat záznam'
      ,de: 'Lösche Datensatz'
      ,es: 'Borrar registro'
      ,fr: 'Effacer enregistrement'
      ,pt: 'Apagar registro'
      ,ro: 'Șterge înregistrarea'
      }
    ,'Move to the top' : {   
      cs: 'Přesuň na začátek'
      ,de: 'Gehe zum Anfang'
      ,es: 'Mover arriba'
      ,fr: 'Déplacer au sommet'
      ,pt: 'Mover para o topo'
      ,ro: 'Mergi la început'
      }
    ,'Hidden' : {   
      cs: 'Skrytý'
      ,de: 'Versteckt'
      ,es: 'Oculto'
      ,fr: 'Caché'
      ,pt: 'Oculto'
      ,ro: 'Ascuns'
      }
    ,'Hide after use' : {   
      cs: 'Skryj po použití'
      ,de: 'Verberge nach Gebrauch'
      ,es: 'Ocultar después de utilizar'
      ,fr: 'Cacher après utilisation'
      ,pt: 'Ocultar após uso'
      ,ro: 'Ascunde după folosireaa'
      }
    ,'Your API secret must be at least 12 characters long' : {   
      cs: 'Vaše API heslo musí mít alespoň 12 znaků'
      ,de: 'Deine API-Prüfsumme muss mindestens 12 Zeichen lang sein'
      ,es: 'Su secreo API debe contener al menos 12 caracteres'
      ,fr: 'Votre secret API doit contenir au moins 12 caractères'
      ,pt: 'Seu segredo de API deve conter no mínimo 12 caracteres'
      ,ro: 'Cheia API trebuie să aibă mai mult de 12 caractere'
      }
    ,'Bad API secret' : {   
      cs: 'Chybné API heslo'
      ,de: 'Fehlerhafte API-Prüfsumme'
      ,es: 'Secreto API incorrecto'
      ,fr: 'Secret API erroné'
      ,pt: 'Segredo de API fraco'
      ,ro: 'Cheie API greșită'
      }
    ,'API secret hash stored' : {   
      cs: 'Hash API hesla uložen'
      ,de: 'API-Prüfsumme gespeichert'
      ,es: 'Hash de secreto API guardado'
      ,fr: 'Hash API secret sauvegardé'
      ,pt: 'Segredo de API guardado'
      ,ro: 'Cheie API înregistrată'
      }
    ,'Status' : {   
      cs: 'Status'
      ,de: 'Status'
      ,es: 'Estado'
      ,fr: 'Statut'
      ,pt: 'Status'
      ,ro: 'Status'
      }
    ,'Not loaded' : {   
      cs: 'Nenačtený'
      ,de: 'Nicht geladen'
      ,es: 'No cargado'
      ,fr: 'Non chargé'
      ,pt: 'Não carregado'
      ,ro: 'Neîncărcat'
      }
    ,'Food editor' : {   
      cs: 'Editor jídel'
      ,de: 'Nahrungsmittel Editor'
      ,es: 'Editor de alimentos'
      ,fr: 'Editeur aliments'
      ,pt: 'Editor de alimentos'
      ,ro: 'Editor alimente'
      }
    ,'Your database' : {   
      cs: 'Vaše databáze'
      ,de: 'Deine Datenbank'
      ,es: 'Su base de datos'
      ,fr: 'Votre base de données'
      ,pt: 'Seu banco de dados'
      ,ro: 'Baza de date'
      }
    ,'Filter' : {   
      cs: 'Filtr'
      ,de: 'Filter'
      ,es: 'Filtro'
      ,fr: 'Filtre'
      ,pt: 'Filtro'
      ,ro: 'Filtru'
      }
    ,'Save' : {   
      cs: 'Ulož'
      ,de: 'Speichern'
      ,es: 'Salvar'
      ,fr: 'Sauver'
      ,pt: 'Salvar'
      ,ro: 'Salvează'
      }
    ,'Clear' : {   
      cs: 'Vymaž'
      ,de: 'Löschen'
      ,es: 'Limpiar'
      ,fr: 'Effacer'
      ,pt: 'Apagar'
      ,ro: 'Inițializare'
      }
    ,'Record' : {   
      cs: 'Záznam'
      ,de: 'Datensatz'
      ,es: 'Guardar'
      ,fr: 'Enregistrement'
      ,pt: 'Gravar'
      ,ro: 'Înregistrare'
      }
    ,'Quick picks' : {   
      cs: 'Rychlý výběr'
      ,de: 'Schnellauswahl'
      ,es: 'Selección rápida'
      ,fr: 'Sélection rapide'
      ,pt: 'Seleção rápida'
      ,ro: 'Selecție rapidă'
      }
    ,'Show hidden' : {   
      cs: 'Zobraz skryté'
      ,de: 'Zeige verborgen'
      ,es: 'Mostrar ocultos'
      ,fr: 'Montrer cachés'
      ,pt: 'Mostrar ocultos'
      ,ro: 'Arată înregistrările ascunse'
      }
    ,'Your API secret' : {   
      cs: 'Vaše API heslo'
      ,de: 'Deine API Prüfsumme'
      ,es: 'Su secreto API'
      ,fr: 'Votre secret API'
      ,pt: 'Seu segredo de API'
      ,ro: 'Cheia API'
      }
    ,'Store hash on this computer (Use only on private computers)' : {   
      cs: 'Ulož hash na tomto počítači (používejte pouze na soukromých počítačích)'
      ,de: 'Speichere Prüfsumme auf diesem Computer (nur auf privaten Computern anwenden)'
      ,es: 'Guardar hash en este ordenador (Usar solo en ordenadores privados)'
      ,fr: 'Sauver le hash sur cet ordinateur (privé uniquement)'
      ,pt: 'Salvar hash nesse computador (Somente em computadores privados)'
      ,ro: 'Salvează cheia pe acest PC (Folosiți doar PC de încredere)'
      }
    ,'Treatments' : {   
      cs: 'Ošetření'
      ,de: 'Bearbeitung'
      ,es: 'Tratamientos'
      ,fr: 'Traitements'
      ,pt: 'Tratamentos'
      ,ro: 'Tratamente'
      }
    ,'Time' : {   
      cs: 'Čas'
      ,de: 'Zeit'
      ,es: 'Hora'
      ,fr: 'Heure'
      ,pt: 'Hora'
      ,ro: 'Ora'
      }
    ,'Event Type' : {   
      cs: 'Typ události'
      ,de: 'Ereignis-Typ'
      ,es: 'Tipo de evento'
      ,fr: 'Type d\'événement'
      ,pt: 'Tipo de evento'
      ,ro: 'Tip eveniment'
      }
    ,'Blood Glucose' : {   
      cs: 'Glykémie'
      ,de: 'Blutglukose'
      ,es: 'Glucemia'
      ,fr: 'Glycémie'
      ,pt: 'Glicemia'
      ,ro: 'Glicemie'
      }
    ,'Entered By' : {   
      cs: 'Zadal'
      ,de: 'Eingabe durch'
      ,es: 'Introducido por'
      ,fr: 'Entré par'
      ,pt: 'Inserido por'
      ,ro: 'Introdus de'
      }
    ,'Delete this treatment?' : {   
      cs: 'Vymazat toto ošetření?'
      ,de: 'Bearbeitung löschen'
      ,es: '¿Borrar este tratamiento?'
      ,fr: 'Effacer ce traitement?'
      ,pt: 'Apagar este tratamento'
      ,ro: 'Șterge acest eveniment?'
      }
    ,'Carbs Given' : {   
      cs: 'Sacharidů'
      ,de: 'Kohlenhydratgabe'
      ,es: 'Hidratos de carbono dados'
      ,fr: 'Glucides donnés'
      ,pt: 'Carboidratos'
      ,ro: 'Carbohidrați'
      }
    ,'Inzulin Given' : {   
      cs: 'Inzulínu'
      ,de: 'Insulingabe'
      ,es: 'Insulina dada'
      ,fr: 'Insuline donnée'
      ,pt: 'Insulina'
      ,ro: 'Insulină administrată'
      }
    ,'Event Time' : {   
      cs: 'Čas události'
      ,de: 'Ereignis Zeit'
      ,es: 'Hora del evento'
      ,fr: 'Heure de l\'événement'
      ,pt: 'Hora do evento'
      ,ro: 'Ora evenimentului'
      }
    ,'Please verify that the data entered is correct' : {   
      cs: 'Prosím zkontrolujte, zda jsou údaje zadány správně'
      ,de: 'Bitte Daten auf Plausibilität prüfen'
      ,es: 'Por favor, verifique que los datos introducidos son correctos'
      ,fr: 'Merci de vérifier la correction des données entrées'
      ,pt: 'Favor verificar se os dados estão corretos'
      ,ro: 'Verificați conexiunea datelor introduse'
      }
    ,'BG' : {   
      cs: 'Glykémie'
      ,de: 'Blutglukose'
      ,es: 'Glucemia en sangre'
      ,fr: 'Glycémie'
      ,pt: 'Glicemia'
      ,ro: 'Glicemie'
      }
    ,'Use BG correction in calculation' : {   
      cs: 'Použij korekci na glykémii'
      ,de: 'Verwende Blutglukose-Korrektur zur Kalkulation'
      ,es: 'Usar la corrección de glucemia en los cálculos'
      ,fr: 'Utiliser la correction de glycémie dans les calculs'
      ,pt: 'Usar correção de glicemia nos cálculos'
      ,ro: 'Folosește corecția de glicemie în calcule'
      }
    ,'BG from CGM (autoupdated)' : {   
      cs: 'Glykémie z CGM (automaticky aktualizovaná)'
      ,de: 'Blutglukose vom CGM (Autoupdate)'
      ,es: 'Glucemia del sensor (Actualizado automáticamente)'
      ,fr: 'Glycémie CGM (automatique)'
      ,pt: 'Glicemia do sensor (Automático)'
      ,ro: 'Glicemie în senzor (automat)'
      }
    ,'BG from meter' : {   
      cs: 'Glykémie z glukoměru'
      ,de: 'Blutzucker vom Messgerät'
      ,es: 'Glucemia del glucómetro'
      ,fr: 'Glycémie glucomètre'
      ,pt: 'Glicemia do glicosímetro'
      ,ro: 'Glicemie în glucometru'
      }
    ,'Manual BG' : {   
      cs: 'Ručně zadaná glykémie'
      ,de: 'Blutzucker händisch'
      ,es: 'Glucemia manual'
      ,fr: 'Glycémie manuelle'
      ,pt: 'Glicemia Manual'
      ,ro: 'Glicemie manuală'
      }
    ,'Quickpick' : {   
      cs: 'Rychlý výběr'
      ,de: 'Schnellauswahl'
      ,es: 'Selección rápida'
      ,fr: 'Sélection rapide'
      ,pt: 'Seleção rápida'
      ,ro: 'Selecție rapidă'
      }
    ,'or' : {   
      cs: 'nebo'
      ,de: 'oder'
      ,es: 'o'
      ,fr: 'ou'
      ,pt: 'or'
      ,ro: 'sau'
      }
    ,'Add from database' : {   
      cs: 'Přidat z databáze'
      ,de: 'Ergänzt aus Datenbank'
      ,es: 'Añadir desde la base de datos'
      ,fr: 'Ajouter à partir de la base de données'
      ,pt: 'Adicionar do banco de dados'
      ,ro: 'Adaugă din baza de date'
      }
    ,'Use carbs correction in calculation' : {   
      cs: 'Použij korekci na sacharidy'
      ,de: 'Verwende Kohlenhydrate-Korrektur zur Kalkulation'
      ,es: 'Usar la corrección de hidratos de carbono en los cálculos'
      ,fr: 'Utiliser la correction en glucides dans les calculs'
      ,pt: 'Usar correção com carboidratos no cálculo'
      ,ro: 'Folosește corecția de carbohidrați în calcule'
      }
    ,'Use COB correction in calculation' : {   
      cs: 'Použij korekci na COB'
      ,de: 'Verwende verzehrte Kohlenhydrate zur Kalkulation'
      ,es: 'Usar la corrección de COB en los cálculos'
      ,fr: 'Utiliser les COB dans les calculs'
      ,pt: 'Usar COB no cálculo'
      ,ro: 'Folosește COB în calcule'
      }
    ,'Use IOB in calculation' : {   
      cs: 'Použij IOB ve výpočtu'
      ,de: 'Verwende gespritzes Insulin zur Kalkulation'
      ,es: 'Usar la IOB en los cálculos'
      ,fr: 'Utiliser l\'IOB dans les calculs'
      ,pt: 'Usar IOB no cálculo'
      ,ro: 'Folosește IOB în calcule'
      }
    ,'Other correction' : {   
      cs: 'Jiná korekce'
      ,de: 'Weitere Korrektur'
      ,es: 'Otra correción'
      ,fr: 'Autre correction'
      ,pt: 'Outra correção'
      ,ro: 'Alte corecții'
      }
    ,'Rounding' : {   
      cs: 'Zaokrouhlení'
      ,de: 'Gerundet'
      ,es: 'Redondeo'
      ,fr: 'Arrondi'
      ,pt: 'Arredondamento'
      ,ro: 'Rotunjire'
	  }
    ,'Enter insulin correction in treatment' : {   
      cs: 'Zahrň inzulín do záznamu ošetření'
      ,de: 'Insulin Korrektur zur Behandlung eingeben'
      ,es: 'Introducir correción de insulina en tratamiento'
      ,fr: 'Entrer correction insuline dans le traitement'
      ,pt: 'Inserir correção de insulina no tratamento'
      ,ro: 'Introdu corecția de insulină în tratament'
      }
    ,'Insulin needed' : {   
      cs: 'Potřebný inzulín'
      ,de: 'Benötigtes Insulin'
      ,es: 'Insulina necesaria'
      ,fr: 'Insuline nécessaire'
      ,pt: 'Insulina necessária'
      ,ro: 'Necesar insulină'
      }
    ,'Carbs needed' : {   
      cs: 'Potřebné sach'
      ,de: 'Benötigte Kohlenhydrate'
      ,es: 'Hidratos de carbono necesarios'
      ,fr: 'Glucides nécessaires'
      ,pt: 'Carboidratos necessários'
      ,ro: 'Necesar carbohidrați'
      }
    ,'Carbs needed if Insulin total is negative value' : {   
      cs: 'Chybějící sacharidy v případě, že výsledek je záporný'
      ,de: 'Benötigte Kohlenhydrate sofern Gesamtinsulin einen negativen Wert aufweist'
      ,es: 'Hidratos de carbono necesarios si el total de insulina es un valor negativo'
      ,fr: 'Glucides nécessaires si insuline totale négative'
      ,pt: 'Carboidratos necessários se Insulina total for negativa'
      ,ro: 'Carbohidrați când necesarul de insulină este negativ'
      }
    ,'Basal rate' : {   
      cs: 'Bazál'
      ,de: 'Basalrate'
      ,es: 'Tasa basal'
      ,fr: 'Taux basal'
      ,pt: 'Taxa basal'
      ,ro: 'Rata bazală'
      }
    ,'60 minutes earlier' : {   
      cs: '60 min předem'
      ,de: '60 Min. früher'
      ,es: '60 min antes'
      ,fr: '60 min avant'
      ,pt: '60 min antes'
      ,ro: 'acum 60 min'
      }
    ,'45 minutes earlier' : {   
      cs: '45 min předem'
      ,de: '45 Min. früher'
      ,es: '45 min antes'
      ,fr: '45 min avant'
      ,pt: '45 min antes'
      ,ro: 'acum 45 min'
      }
    ,'30 minutes earlier' : {   
      cs: '30 min předem'
      ,de: '30 Min früher'
      ,es: '30 min antes'
      ,fr: '30 min avant'
      ,pt: '30 min antes'
      ,ro: 'acum 30 min'
      }
    ,'20 minutes earlier' : {   
      cs: '20 min předem'
      ,de: '20 Min. früher'
      ,es: '20 min antes'
      ,fr: '20 min avant'
      ,pt: '20 min antes'
      ,ro: 'acum 20 min'
      }
    ,'15 minutes earlier' : {   
      cs: '15 min předem'
      ,de: '15 Min. früher'
      ,es: '15 min antes'
      ,fr: '15 min avant'
      ,pt: '15 min antes'
      ,ro: 'acu 15 min'
      }
    ,'Time in minutes' : {   
      cs: 'Čas v minutách'
      ,de: 'Zeit in Minuten'
      ,es: 'Tiempo en minutos'
      ,fr: 'Durée en minutes'
      ,pt: 'Tempo em minutos'
      ,ro: 'Timp în minute'
      }
    ,'15 minutes later' : {   
      cs: '15 min po'
      ,de: '15 Min. später'
      ,es: '15 min más tarde'
      ,fr: '15 min après'
      ,ro: 'după 15 min'
      }
    ,'20 minutes later' : {   
      cs: '20 min po'
      ,de: '20 Min. später'
      ,es: '20 min más tarde'
      ,fr: '20 min après'
      ,pt: '20 min depois'
      ,ro: 'după 20 min'
      }
    ,'30 minutes later' : {   
      cs: '30 min po'
      ,de: '30 Min. später'
      ,es: '30 min más tarde'
      ,fr: '30 min après'
      ,pt: '30 min depois'
      ,ro: 'după 30 min'
      }
    ,'45 minutes later' : {   
      cs: '45 min po'
      ,de: '45 Min. später'
      ,es: '45 min más tarde'
      ,fr: '45 min après'
      ,pt: '45 min depois'
      ,ro: 'după 45 min'
      }
    ,'60 minutes later' : {   
      cs: '60 min po'
      ,de: '60 Min. später'
      ,es: '60 min más tarde'
      ,fr: '60 min après'
      ,pt: '60 min depois'
      ,ro: 'după 60 min'
      }
    ,'Additional Notes, Comments' : {   
      cs: 'Dalši poznámky, komentáře'
      ,de: 'Ergänzende Hinweise / Kommentare'
      ,es: 'Notas adicionales, Comentarios'
      ,fr: 'Notes additionnelles, commentaires'
      ,pt: 'Notas adicionais e comentários'
      ,ro: 'Note adiționale, comentarii'
      }
    ,'RETRO MODE' : {   
      cs: 'V MINULOSTI'
      ,de: 'RETRO MODUS'
      ,es: 'Modo Retrospectivo'
      ,fr: 'MODE RETROSPECTIF'
      ,pt: 'Modo Retrospectivo'
      ,ro: 'MOD RETROSPECTIV'
      }
    ,'Now' : {   
      cs: 'Nyní'
      ,de: 'Jetzt'
      ,es: 'Ahora'
      ,fr: 'Maintenant'
      ,pt: 'Agora'
      ,ro: 'Acum'
      }
    ,'Other' : {   
      cs: 'Jiný'
      ,de: 'Weitere'
      ,es: 'Otro'
      ,fr: 'Autre'
      ,pt: 'Outro'
      ,ro: 'Altul'
      }
    ,'Submit Form' : {   
      cs: 'Odeslat formulář'
      ,de: 'Eingabe senden'
      ,es: 'Enviar formulario'
      ,fr: 'Formulaire de soumission'
      ,pt: 'Submeter formulário'
      ,ro: 'Trimite formularul'
      }
    ,'Profile editor' : {   
      cs: 'Editor profilu'
      ,de: 'Profil-Einstellungen'
      ,es: 'Editor de perfil'
      ,fr: 'Editeur de profil'
      ,pt: 'Editor de perfil'
      ,ro: 'Editare profil'
      }
    ,'Reporting tool' : {   
      cs: 'Výkazy'
      ,de: 'Berichte'
      ,es: 'Herramienta de informes'
      ,fr: 'Outil de rapport'
      ,pt: 'Ferramenta de relatórios'
      ,ro: 'Instrument de rapoarte'
      }
    ,'Add food from your database' : {   
      cs: 'Přidat jidlo z Vaší databáze'
      ,de: 'Ergänzt durch deine Datenbank'
      ,es: 'Añadir alimento a su base de datos'
      ,fr: 'Ajouter aliment de votre base de données'
      ,pt: 'Incluir alimento do seu banco de dados'
      ,ro: 'Adaugă alimente din baza de date'
      }
    ,'Reload database' : {   
      cs: 'Znovu nahraj databázi'
      ,de: 'Datenbank nachladen'
      ,es: 'Recargar base de datos'
      ,fr: 'Recharger la base de données'
      ,pt: 'Recarregar banco de dados'
      ,ro: 'Reîncarcă baza de date'
      }
    ,'Add' : {   
      cs: 'Přidej'
      ,de: 'Hinzufügen'
      ,es: 'Añadir'
      ,fr: 'Ajouter'
      ,pt: 'Adicionar'
      ,ro: 'Adaugă'
      }
    ,'Unauthorized' : {   
      cs: 'Neautorizováno'
      ,de: 'Unbestätigt'
      ,es: 'No autorizado'
      ,fr: 'Non autorisé'
      ,pt: 'Não autorizado'
      ,ro: 'Neautorizat'
      }
    ,'Entering record failed' : {   
      cs: 'Vložení záznamu selhalo'
      ,de: 'Eingabe Datensatz fehlerhaft'
      ,es: 'Entrada de registro fallida'
      ,fr: 'Entrée enregistrement a échoué'
      ,pt: 'Entrada de registro falhou'
      ,ro: 'Înregistrare eșuată'
      }
    ,'Device authenticated' : {   
      cs: 'Zařízení ověřeno'
      ,de: 'Gerät authentifiziert'
      ,es: 'Dispositivo autenticado'
      ,fr: 'Appareil authentifié'
      ,pt: 'Dispositivo autenticado'
      ,ro: 'Dispozitiv autentificat'
      }
    ,'Device not authenticated' : {   
      cs: 'Zařízení není ověřeno'
      ,de: 'Gerät nicht authentifiziert'
      ,es: 'Dispositivo no autenticado'
      ,fr: 'Appareil non authentifié'
      ,pt: 'Dispositivo não autenticado'
      ,ro: 'Dispozitiv neautentificat'
      }
    ,'Authentication status' : {   
      cs: 'Stav ověření'
      ,de: 'Authentifications Status'
      ,es: 'Estado de autenticación'
      ,fr: 'Status de l\'authentification'
      ,pt: 'Status de autenticação'
      ,ro: 'Starea autentificării'
      }
    ,'Authenticate' : {   
      cs: 'Ověřit'
      ,de: 'Authentifizieren'
      ,es: 'Autenticar'
      ,fr: 'Authentifier'
      ,pt: 'Autenticar'
      ,ro: 'Autentificare'
      }
    ,'Remove' : {   
      cs: 'Vymazat'
      ,de: 'Entfernen'
      ,es: 'Eliminar'
      ,fr: 'Retirer'
      ,pt: 'Remover'
      ,ro: 'Șterge'
      }
    ,'Your device is not authenticated yet' : {
      cs: 'Toto zařízení nebylo dosud ověřeno'
      ,de: 'Dein Gerät ist derzeit nicht authentifiziert'
      ,es: 'Su dispositivo no ha sido autenticado todavía'
      ,fr: 'Votre appareil n\'est pas encore authentifié'
      ,pt: 'Seu dispositivo ainda não foi autenticado'
      ,ro: 'Dispozitivul nu este autentificat încă'
      }
    ,'Sensor' : {   
      cs: 'Senzor'
      ,de: 'Sensor'
      ,es: 'Sensor'
      ,fr: 'Senseur'
      ,pt: 'Sensor'
      ,ro: 'Senzor'
      }
    ,'Finger' : {   
      cs: 'Glukoměr'
      ,de: 'Finger'
      ,es: 'Dedo'
      ,fr: 'Doigt'
      ,pt: 'Dedo'
      ,ro: 'Deget'
      }
    ,'Manual' : {   
      cs: 'Ručně'
      ,de: 'Händisch'
      ,es: 'Manual'
      ,fr: 'Manuel'
      ,pt: 'Manual'
      ,ro: 'Manual'
      }
    ,'Scale' : {   
      cs: 'Měřítko'
      ,de: 'Messen'
      ,es: 'Escala'
      ,fr: 'Echelle'
      ,pt: 'Escala'
      ,ro: 'Scală'
      }
    ,'Linear' : {   
      cs: 'lineární'
      ,de: 'Linear'
      ,es: 'Lineal'
      ,fr: 'Linéaire'
      ,pt: 'Linear'
      ,ro: 'Liniar'
      }
    ,'Logarithmic' : {   
      cs: 'logaritmické'
      ,de: 'Logarithmisch'
      ,es: 'Logarítmica'
      ,fr: 'Logarithmique'
      ,pt: 'Logarítmica'
      ,ro: 'Logaritmic'
      }
    ,'Silence for 30 minutes' : {   
      cs: 'Ztlumit na 30 minut'
      ,de: 'Ausschalten für 30 Minuten'
      ,es: 'Silenciar durante 30 minutos'
      ,fr: 'Silence pendant 30 minutes'
      ,pt: 'Silenciar por 30 minutos'
      ,ro: 'Ignoră pentru 30 minute'
      }
    ,'Silence for 60 minutes' : {   
      cs: 'Ztlumit na 60 minut'
      ,de: 'Ausschalten für 60 Minuten'
      ,es: 'Silenciar durante 60 minutos'
      ,fr: 'Silence pendant 60 minutes'
      ,pt: 'Silenciar por 60 minutos'
      ,ro: 'Ignoră pentru 60 minute'
      }
    ,'Silence for 90 minutes' : {   
      cs: 'Ztlumit na 90 minut'
      ,de: 'Ausschalten für 90 Minuten'
      ,es: 'Silenciar durante 90 minutos'
      ,fr: 'Silence pendant 90 minutes'
      ,pt: 'Silenciar por 90 minutos'
      ,ro: 'Ignoră pentru 90 minure'
      }
    ,'Silence for 120 minutes' : {   
      cs: 'Ztlumit na 120 minut'
      ,de: 'Ausschalten für 120 Minuten'
      ,es: 'Silenciar durante 120 minutos'
      ,fr: 'Silence pendant 120 minutes'
      ,pt: 'Silenciar por 120 minutos'
      ,ro: 'Ignoră pentru 120 minute'
      }
    ,'3HR' : {   
      cs: '3hod'
      ,de: '3h'
      ,es: '3h'
      ,fr: '3hr'
      ,pr: '3h'
      ,ro: '3h'
      }
    ,'6HR' : {   
      cs: '6hod'
      ,de: '6h'
      ,es: '6h'
      ,fr: '6hr'
      ,pr: '6h'
      ,ro: '6h'
      }
    ,'12HR' : {   
      cs: '12hod'
      ,de: '12h'
      ,es: '12h'
      ,fr: '12hr'
      ,pr: '12h'
      ,ro: '12h'
      }
    ,'24HR' : {   
      cs: '24hod'
      ,de: '24h'
      ,es: '24h'
      ,fr: '24hr'
      ,pr: '24h'
      ,ro: '24h'
      }
    ,'Settings' : {
      cs: 'Nastavení'
      ,de: 'Einstellungen'
      ,es: 'Ajustes'
      ,fr: 'Paramètres'
      ,pr: 'Definições'
      ,ro: 'Setări'
      }
    ,'Units' : {
      cs: 'Jednotky'
      ,de: 'Einheiten'
      ,es: 'Unidades'
      ,fr: 'Unités'
      ,pr: 'Unidades'
      ,ro: 'Unități'
      }
    ,'Date format' : {   
      cs: 'Formát datumu'
      ,de: 'Datum Format'
      ,es: 'Formato de fecha'
      ,fr: 'Format Date'
      ,pr: 'Formato de data'
      ,ro: 'Formatul datei'
      }
    ,'12 hours' : {   
      cs: '12 hodin'
      ,de: '12 Stunden'
      ,es: '12 horas'
      ,fr: '12hr'
      ,pr: '12 horas'
      ,ro: '12 ore'
      }
    ,'24 hours' : {   
      cs: '24 hodin'
      ,de: '24 Stunden'
      ,es: '24 horas'
      ,fr: '24hr'
      ,pr: '24 horas'
      ,ro: '24 ore'
      }
    ,'Log a Treatment' : {   
      cs: 'Záznam ošetření'
      ,de: 'Dateneingabe'
      ,es: 'Apuntar un tratamiento'
      ,fr: 'Entrer un traitement'
      ,pr: 'Entre um tratamento'
      ,ro: 'Înregistrează un eveniment'
      }
    ,'BG Check' : {   
      cs: 'Kontrola glykémie'
      ,de: 'Blutglukose-Prüfung'
      ,es: 'Control de glucemia'
      ,fr: 'Contrôle glycémie'
      ,pr: 'Medida de glicemia'
      ,ro: 'Verificare glicemie'
      }
    ,'Meal Bolus' : {   
      cs: 'Bolus na jídlo'
      ,de: 'Mahlzeiten Bolus'
      ,es: 'Bolo de comida'
      ,fr: 'Bolus repas'
      ,pr: 'Bolus de refeição'
      ,ro: 'Bolus masă'
      }
    ,'Snack Bolus' : {   
      cs: 'Bolus na svačinu'
      ,de: 'Snack Bolus'
      ,es: 'Bolo de aperitivo'
      ,fr: 'Bolus friandise'
      ,pr: 'Bolus de lanche'
      ,ro: 'Bolus gustare'
      }
    ,'Correction Bolus' : {   
      cs: 'Bolus na glykémii'
      ,de: 'Korrektur Bolus'
      ,es: 'Bolo corrector'
      ,fr: 'Bolus de correction'
      ,pr: 'Bolus de correção'
      ,ro: 'Bolus corecție'
      }
    ,'Carb Correction' : {   
      cs: 'Přídavek sacharidů'
      ,de: 'Kohlenhydrate Korrektur'
      ,es: 'Hidratos de carbono de corrección'
      ,fr: 'Correction glucide'
      ,pr: 'Carboidrato de correção'
      ,ro: 'Corecție de carbohidrați'
      }
    ,'Note' : {   
      cs: 'Poznámka'
      ,de: 'Bemerkungen'
      ,es: 'Nota'
      ,fr: 'Note'
      ,pr: 'Nota'
      ,ro: 'Notă'
      }
    ,'Question' : {   
      cs: 'Otázka'
      ,de: 'Frage'
      ,es: 'Pregunta'
      ,fr: 'Question'
      ,pr: 'Pergunta'
      ,ro: 'Întrebare'
      }
    ,'Exercise' : {   
      cs: 'Cvičení'
      ,de: 'Bewegung'
      ,es: 'Ejercicio'
      ,fr: 'Exercice'
      ,pr: 'Exercício'
      ,ro: 'Activitate fizică'
      }
    ,'Pump Site Change' : {   
      cs: 'Přepíchnutí kanyly'
      ,de: 'Pumpen-Katheter Wechsel'
      ,es: 'Cambio de catéter'
      ,fr: 'Changement de site pompe'
      ,pr: 'Troca de catéter'
      ,ro: 'Schimbare loc pompă'
      }
    ,'Sensor Start' : {   
      cs: 'Spuštění sensoru'
      ,de: 'Sensor Start'
      ,es: 'Inicio de sensor'
      ,fr: 'Démarrage senseur'
      ,pr: 'Início de sensor'
      ,ro: 'Start senzor'
      }
    ,'Sensor Change' : {   
      cs: 'Výměna sensoru'
      ,de: 'Sensor Wechsel'
      ,es: 'Cambio de sensor'
      ,fr: 'Changement senseur'
      ,pr: 'Troca de sensor'
      ,ro: 'Schimbare senzor'
      }
    ,'Dexcom Sensor Start' : {   
      cs: 'Spuštění sensoru'
      ,de: 'Dexcom Sensor Start'
      ,es: 'Inicio de sensor Dexcom'
      ,fr: 'Démarrage senseur Dexcom'
      ,pr: 'Início de sensor Dexcom'
      ,ro: 'Pornire senzor Dexcom'
      }
    ,'Dexcom Sensor Change' : {   
      cs: 'Výměna sensoru'
      ,de: 'Dexcom Sensor Wechsel'
      ,es: 'Cambio de sensor Dexcom'
      ,fr: 'Changement senseur Dexcom'
      ,pr: 'Troca de sensor Dexcom'
      ,ro: 'Schimbare senzor Dexcom'
      }
    ,'Insulin Cartridge Change' : {   
      cs: 'Výměna inzulínu'
      ,de: 'Insulin Ampullen Wechsel'
      ,es: 'Cambio de reservorio de insulina'
      ,fr: 'Changement cartouche d\'insuline'
      ,pr: 'Troca de reservatório de insulina'
      ,ro: 'Schimbare cartuș insulină'
      }
    ,'D.A.D. Alert' : {   
      cs: 'D.A.D. Alert'
      ,de: 'Diabetes-Hund Alarm'
      ,es: 'Alerta de perro de alerta diabética'
      ,fr: 'Wouf! Wouf! Chien d\'alerte diabète'
      ,pr: 'Alerta de cão sentinela de diabetes'
      ,ro: 'Alertă câine de serviciu'
      }
    ,'Glucose Reading' : {   
      cs: 'Hodnota glykémie'
      ,de: 'Glukose Messwert'
      ,es: 'Valor de glucemia'
      ,fr: 'Valeur de glycémie'
      ,pr: 'Valor de glicemia'
      ,ro: 'Valoare glicemie'
      }
    ,'Measurement Method' : {   
      cs: 'Metoda měření'
      ,de: 'Messmethode'
      ,es: 'Método de medida'
      ,fr: 'Méthode de mesure'
      ,pr: 'Método de medida'
      ,ro: 'Metodă măsurare'
      }
    ,'Meter' : {   
      cs: 'Glukoměr'
      ,de: 'BZ-Messgerät'
      ,fr: 'Glucomètre'
      ,pr: 'Glicosímetro'
      ,ro: 'Glucometru'
      ,es: 'Glucómetro'
      }
    ,'Insulin Given' : {   
      cs: 'Inzulín'
      ,de: 'Insulingabe'
      ,es: 'Insulina'
      ,fr: 'Insuline donnée'
      ,pr: 'Insulina'
      ,ro: 'Insulină administrată'
      }
    ,'Amount in grams' : {   
      cs: 'Množství v gramech'
      ,de: 'Menge in Gramm'
      ,es: 'Cantidad en gramos'
      ,fr: 'Quantité en grammes'
      ,pr: 'Quantidade em gramas'
      ,ro: 'Cantitate în grame'
      }
    ,'Amount in units' : {   
      cs: 'Množství v jednotkách'
      ,de: 'Anzahl in Einheiten'
      ,es: 'Cantidad en unidades'
      ,fr: 'Quantité en unités'
      ,pr: 'Quantidade em unidades'
      ,ro: 'Cantitate în unități'
      }
    ,'View all treatments' : {   
      cs: 'Zobraz všechny ošetření'
      ,de: 'Zeige alle Eingaben'
      ,es: 'Visualizar todos los tratamientos'
      ,fr: 'Voir tous les traitements'
      ,pr: 'Visualizar todos os tratamentos'
      ,ro: 'Vezi toate evenimentele'
      }
    ,'Enable Alarms' : {   
      cs: 'Povolit alarmy'
      ,de: 'Alarm einschalten'
      ,es: 'Activar las alarmas'
      ,fr: 'Activer les alarmes'
      ,pr: 'Ativar alarmes'
      ,ro: 'Activează alarmele'
      }
    ,'When enabled an alarm may sound.' : {   
      cs: 'Při povoleném alarmu zní zvuk'
      ,de: 'Sofern eingeschaltet ertönt ein Alarm'
      ,es: 'Cuando estén activas, una alarma podrá sonar'
      ,fr: 'Si activée, un alarme peut sonner.'
      ,pr: 'Quando ativado, um alarme poderá soar'
      ,ro: 'Când este activ, poate suna o alarmă.'
      }
    ,'Urgent High Alarm' : {   
      cs: 'Urgentní vysoká glykémie'
      ,de: 'Achtung Hoch Alarm'
      ,es: 'Alarma de glucemia alta urgente'
      ,fr: 'Alarme haute urgente'
      ,pr: 'Alarme de alto urgente'
      ,ro: 'Alarmă urgentă hiper'
      }
    ,'High Alarm' : {   
      cs: 'Vysoká glykémie'
      ,de: 'Hoch Alarm'
      ,es: 'Alarma de glucemia alta'
      ,fr: 'Alarme haute'
      ,pr: 'Alarme de alto'
      ,ro:  'Alarmă hiper'
      }
    ,'Low Alarm' : {   
      cs: 'Nízká glykémie'
      ,de: 'Tief Alarm'
      ,es: 'Alarma de glucemia baja'
      ,fr: 'Alarme basse'
      ,pr: 'Alarme de baixo'
      ,ro: 'Alarmă hipo'
      }
    ,'Urgent Low Alarm' : {   
      cs: 'Urgentní nízká glykémie'
      ,de: 'Achtung Tief Alarm'
      ,es: 'Alarma de glucemia baja urgente'
      ,fr: 'Alarme basse urgente'
      ,pr: 'Alarme de baixo urgente'
      ,ro: 'Alarmă urgentă hipo'
      }
    ,'Stale Data: Warn' : {   
      cs: 'Zastaralá data'
      ,de: 'Warnung: Daten nicht mehr gültig'
      ,es: 'Datos obsoletos: aviso'
      ,fr: 'Données dépassées'
      ,pr: 'Dados antigos: aviso'
      ,ro: 'Date învechite: alertă'
      }
    ,'Stale Data: Urgent' : {   
      cs: 'Zastaralá data urgentní'
      ,de: 'Achtung: Daten nicht mehr gültig'
      ,es: 'Datos obsoletos: Urgente'
      ,fr: 'Données dépassées urgentes'
      ,pr: 'Dados antigos: Urgente'
      ,ro: 'Date învechite: urgent'
      }
    ,'mins' : {   
      cs: 'min'
      ,de: 'min'
      ,es: 'min'
      ,fr: 'mins'
      ,pr: 'min'
      ,ro: 'min'
      }
    ,'Night Mode' : {   
      cs: 'Noční mód'
      ,de: 'Nacht Modus'
      ,es: 'Modo nocturno'
      ,fr: 'Mode nocturne'
      ,pr: 'Modo noturno'
      ,ro: 'Mod nocturn'
      }
    ,'When enabled the page will be dimmed from 10pm - 6am.' : {   
      cs: 'Když je povoleno, obrazovka je ztlumena 22:00 - 6:00'
      ,de: 'Wenn aktiviert wird die Anzeige von 22 Uhr - 6 Uhr gedimmt'
      ,es: 'Cuando esté activo, el brillo de la página bajará de 10pm a 6am.'
      ,fr: 'Si activé, la page sera assombire de 22:00 à 6:00'
      ,pr: 'Se ativado, a página será escurecida de 22h a 6h'
      ,ro: 'La activare va scădea iluminarea între 22 și 6'
      }
    ,'Enable' : {   
      cs: 'Povoleno'
      ,de: 'Eingeschaltet'
      ,es: 'Activar'
      ,fr: 'activer'
      ,pr: 'Ativar'
      ,ro: 'Activează'
      }
    ,'Show Raw BG Data' : {
      cs: 'Zobraz RAW data'
      ,de: 'Zeige Roh-Blutglukose Daten'
      ,es: 'Mostrat datos en glucemia en crudo'
      ,fr: 'Montrer les données BG brutes'
      ,pr: 'Mostrar dados de glicemia não processados'
      ,ro: 'Afișează date primare glicemie'
      }
    ,'Never' : {   
      cs: 'Nikdy'
      ,de: 'Nie'
      ,es: 'Nunca'
      ,fr: 'Jamais'
      ,pr: 'Nunca'
      ,ro: 'Niciodată'
      }
    ,'Always' : {   
      cs: 'Vždy'
      ,de: 'Immer'
      ,es: 'Siempre'
      ,fr: 'Toujours'
      ,pr: 'Sempre'
      ,ro: 'Întotdeauna'
      }
    ,'When there is noise' : {   
      cs: 'Při šumu'
      ,de: 'Sofern Störgeräusch vorhanden'
      ,es: 'Cuando hay ruido'
      ,fr: 'Quand il y a du bruit'
      ,pr: 'Quando houver ruído'
      ,ro: 'Atunci când este diferență'
      }
    ,'When enabled small white dots will be disaplyed for raw BG data' : {   
      cs: 'Když je povoleno, malé tečky budou zobrazeny pro RAW data'
      ,de: 'Bei Aktivierung erscheinen kleine weiße Punkte für Roh-Blutglukose Daten'
      ,es: 'Cuando esté activo, pequeños puntos blancos mostrarán los datos en crudo'
      ,fr: 'Si activé, des points blancs représenteront les données brutes'
      ,pr: 'Se ativado, pontinhos brancos representarão os dados de glicemia não processados'
      ,ro: 'La activare vor apărea puncte albe reprezentând citirea brută a glicemiei'
      }
    ,'Custom Title' : {   
      cs: 'Vlastní název stránky'
      ,de: 'Benutzerdefiniert'
      ,es: 'Título personalizado'
      ,fr: 'Titre sur mesure'
      ,pr: 'Customizar Título'
      ,ro: 'Titlu particularizat'
      }
    ,'Theme' : {   
      cs: 'Téma'
      ,de: 'Thema'
      ,es: 'Tema'
      ,fr: 'Thème'
      ,pr: 'tema'
      ,ro: 'Temă'
      }
    ,'Default' : {   
      cs: 'Výchozí'
      ,de: 'Voreingestellt'
      ,es: 'Por defecto'
      ,fr: 'Par défaut'
      ,pr: 'Padrão'
      ,ro: 'Implicită'
      }
    ,'Colors' : {   
      cs: 'Barevné'
      ,de: 'Farben'
      ,es: 'Colores'
      ,fr: 'Couleurs'
      ,pr: 'Cores'
      ,ro: 'Colorată'
      }
    ,'Reset, and use defaults' : {   
      cs: 'Vymaž a nastav výchozí hodnoty'
      ,de: 'Zurücksetzen und Voreinstellungen verwenden'
      ,es: 'Inicializar y utilizar los valores por defecto'
      ,fr: 'Remise à zéro et utilisation des valeurs par défaut'
      ,pr: 'Zerar e usar padrões'
      ,ro: 'Resetează și folosește setările implicite'
      }
    ,'Calibrations' : {   
      cs: 'Kalibrace'
      ,de: 'Kalibrierung'
      ,es: 'Calibraciones'
      ,fr: 'Calibration'
      ,pr: 'Calibraçôes'
      ,ro: 'Calibrări'
      }
    ,'Alarm Test / Smartphone Enable' : {   
      cs: 'Test alarmu'
      ,de: 'Alarm Test / Smartphone aktivieren'
      ,es: 'Test de Alarma / Activar teléfono'
      ,fr: 'Test alarme'
      ,pr: 'Testar Alarme / Ativar Smartphone'
      ,ro: 'Teste alarme / Activează pe smartphone'
      }
    ,'Bolus Wizard' : {   
      cs: 'Bolusový kalkulátor'
      ,de: 'Bolus Kalkulator'
      ,es: 'Bolus Wizard'
      ,fr: 'Calculateur de bolus'
      ,pr: 'Bolus Wizard'
      ,ro: 'Calculator sugestie bolus'
      }
    ,'in the future' : {   
      cs: 'v budoucnosti'
      ,de: 'in der Zuknft'
      ,es: 'en el futuro'
      ,fr: 'dans le futur'
      ,pr: 'no futuro'
      ,ro: 'în viitor'
      }
    ,'time ago' : {   
      cs: 'min zpět'
      ,de: 'Aktualisiert'
      ,es: 'tiempo atrás'
      ,fr: 'temps avant'
      ,pr: 'tempo atrás'
      ,ro: 'în trecut'
      }
    ,'hr ago' : {   
      cs: 'hod zpět'
      ,de: 'Std. vorher'
      ,es: 'hr atrás'
      ,fr: 'hr avant'
      ,pr: 'h atrás'
      ,ro: 'oră în trecut'
      }
    ,'hrs ago' : {   
      cs: 'hod zpět'
      ,de: 'Std. vorher'
      ,es: 'hr atrás'
      ,fr: 'hrs avant'
      ,pr: 'h atrás'
      ,ro: 'h în trecut'
      }
    ,'min ago' : {   
      cs: 'min zpět'
      ,de: 'Min. vorher'
      ,es: 'min atrás'
      ,fr: 'min avant'
      ,pr: 'min atrás'
      ,ro: 'minut în trecut'
      }
    ,'mins ago' : {   
      cs: 'min zpět'
      ,de: 'Min. vorher'
      ,es: 'min atrás'
      ,fr: 'mins avant'
      ,pr: 'min atrás'
      ,ro: 'minute în trecut'
      }
    ,'day ago' : {   
      cs: 'den zpět'
      ,de: 'Tag vorher'
      ,es: 'día atrás'
      ,fr: 'jour avant'
      ,pr: 'dia atrás'
      ,ro: 'zi în trecut'
      }
    ,'days ago' : {   
      cs: 'dnů zpět'
      ,de: 'Tage vorher'
      ,es: 'días atrás'
      ,fr: 'jours avant'
      ,pr: 'dias atrás'
      ,ro: 'zile în trecut'
      }
    ,'long ago' : {   
      cs: 'dlouho zpět'
      ,de: 'Lange her'
      ,es: 'Hace mucho tiempo'
      ,fr: 'il y a très longtemps...'
      ,pr: 'muito tempo atrás'
      ,ro: 'timp în trecut'
      }
    ,'Clean' : {   
      cs: 'Čistý'
      ,de: 'Komplett'
      ,es: 'Limpio'
      ,fr: 'Propre'
      ,pr: 'Limpo'
      ,ro: 'Curat'
      }
    ,'Light' : {   
      cs: 'Lehký'
      ,de: 'Leicht'
      ,es: 'Ligero'
      ,fr: 'Léger'
      ,pr: 'Leve'
      ,ro: 'Ușor'
      }
    ,'Medium' : {   
      cs: 'Střední'
      ,de: 'Mittel'
      ,es: 'Medio'
      ,fr: 'Moyen'
      ,pr: 'Médio'
      ,ro: 'Mediu'
      }
    ,'Heavy' : {   
      cs: 'Velký'
      ,de: 'Schwer'
      ,es: 'Fuerte'
      ,fr: 'Important'
      ,pr: 'Pesado'
      ,ro: 'Puternic'
      }
    ,'Treatment type' : {   
      cs: 'Typ ošetření'
      ,de: 'Eingabe Typ'
      ,es: 'Tipo de tratamiento'
      ,fr: 'Type de traitement'
      ,pr: 'Tipo de tratamento'
      ,ro: 'Tip tratament'
      }
    ,'Raw BG' : {   
      cs: 'Glykémie z RAW dat'
      ,de: 'Roh Blutglukose'
      ,es: 'Glucemia en crudo'
      ,fr: 'BG brut'
      ,pr: 'Glicemia sem processamento'
      ,ro: 'Citire brută a glicemiei'
      }
    ,'Device' : {   
      cs: 'Zařízení'
      ,de: 'Gerät'
      ,es: 'Dispositivo'
      ,fr: 'Appareil'
      ,pr: 'Dispositivo'
      ,ro: 'Dispozitiv'
      }
    ,'Noise' : {   
      cs: 'Šum'
      ,de: 'Störgeräusch'
      ,es: 'Ruido'
      ,fr: 'Bruit'
      ,pr: 'Ruído'
      ,ro: 'Zgomot'
      }
    ,'Calibration' : {   
      cs: 'Kalibrace'
      ,de: 'Kalibrierung'
      ,es: 'Calibración'
      ,fr: 'Calibration'
      ,pr: 'Calibração'
      ,ro: 'Calibrare'
      }
    ,'Show Plugins' : {   
      cs: 'Zobrazuj pluginy'
      ,de: 'Zeige Plugins'
      ,es: 'Mostrar Plugins'
      ,pr: 'Mostrar Plugins'
      ,ro: 'Arată plugin-urile'
      }
    ,'About' : {   
      cs: 'O aplikaci'
      ,de: 'Über'
      ,es: 'Sobre'
      ,pr: 'Sobre'
      ,ro: 'Despre'
      }
    ,'Value in' : {   
      cs: 'Hodnota v'
      ,de: 'Wert in'
      ,es: 'Valor en'
      ,pr: 'Valor em'
      ,ro: 'Valoare în'
      }
    ,'Carb Time' : {   
      cs: 'Čas jídla'
      ,de: 'Kohlenhydrate Zeit'
      ,es: 'Momento de la ingesta'
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
