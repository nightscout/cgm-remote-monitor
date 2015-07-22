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
      ,fr: 'Ecoute sur port'
      ,pt: 'Escutando porta'
      }
    // Client
    ,'Mo' : {
      cs: 'Po'
      ,de: 'Mo'
      ,fr: 'Lu'
      ,pt: 'Seg'
      }
    ,'Tu' : {
      cs: 'Út'
      ,de: 'Di'
      ,fr: 'Ma'
      ,pt: 'Ter'
      },
    ',We' : {
      cs: 'St'
      ,de: 'Mi'
      ,fr: 'Me'
      ,pt: 'Qua'
      }
    ,'Th' : {
      cs: 'Čt'
      ,de: 'Do'
      ,fr: 'Je'
      ,pt: 'Qui'
      }
    ,'Fr' : {
      cs: 'Pá'
      ,de: 'Fr'
      ,fr: 'Ve'
      ,pt: 'Sex'
      }
    ,'Sa' : {
      cs: 'So'
      ,de: 'Sa'
      ,fr: 'Sa'
      ,pt: 'Sa'
      }
    ,'Su' : {
      cs: 'Ne'
      ,de: 'So'
      ,fr: 'Di'
      ,pt: 'Dom'
      }
    ,'Monday' : {
      cs: 'Pondělí'
      ,de: 'Montag'
      ,fr: 'Lundi'
      ,pt: 'Segunda'
      }
    ,'Tuesday' : {
      cs: 'Úterý'
      ,de: 'Dienstag'
      ,fr: 'Mardi'
      ,pt: 'Terça'
      }
    ,'Wednesday' : {
      cs: 'Středa'
      ,de: 'Mittwoch'
      ,fr: 'Mercredi'
      ,pt: 'Quarta'
      }
    ,'Thursday' : {
      cs: 'Čtvrtek'
      ,de: 'Donnerstag'
      ,fr: 'Jeudi'
      ,pt: 'Quinta'
      }
    ,'Friday' : {
      cs: 'Pátek'
      ,de: 'Freitag'
      ,fr: 'Vendredi'
      ,pt: 'Sexta'
      }
    ,'Saturday' : {
      cs: 'Sobota'
      ,de: 'Samstag'
      ,fr: 'Samedi'
      ,pt: 'Sábado'
      }
    ,'Sunday' : {
      cs: 'Neděle'
      ,de: 'Sonntag'
      ,fr: 'Dimanche'
      ,pt: 'Domingo'
      }
    ,'Category' : {
      cs: 'Kategorie'
      ,de: 'Kategorie'
      ,fr: 'Catégorie'
      ,pt: 'Categoria'
      }
    ,'Subcategory' : {   
      cs: 'Podkategorie'
      ,de: 'Unterkategorie'
      ,fr: 'Sous-catégorie'
      ,pt: 'Subcategoria'
      }
    ,'Name' : {   
      cs: 'Jméno'
      ,de: 'Name'
      ,fr: 'Nom'
      ,pt: 'Nome'
      }
    ,'Today' : {   
      cs: 'Dnes'
      ,de: 'Heute'
      ,fr: 'Aujourd\'hui'
      ,pt: 'Hoje'
      }
    ,'Last 2 days' : {   
      cs: 'Poslední 2 dny'
      ,de: 'letzte 2 Tage'
      ,fr: '2 derniers jours'
      ,pt: 'Últimos 2 dias'
      }
    ,'Last 3 days' : {   
      cs: 'Poslední 3 dny'
      ,de: 'letzte 3 Tage'
      ,fr: '3 derniers jours'
      ,pt: 'Últimos 3 dias'
      }
    ,'Last week' : {   
      cs: 'Poslední týden'
      ,de: 'letzte Woche'
      ,fr: 'Semaine Dernière'
      ,pt: 'Semana passada'
      }
    ,'Last 2 weeks' : {   
      cs: 'Poslední 2 týdny'
      ,de: 'letzte 2 Wochen'
      ,fr: '2 dernières semaines'
      ,pt: 'Últimas 2 semanas'
      }
    ,'Last month' : {   
      cs: 'Poslední měsíc'
      ,de: 'letzter Monat'
      ,fr: 'Mois dernier'
      ,pt: 'Mês passado'
      }
    ,'Last 3 months' : {   
      cs: 'Poslední 3 měsíce'
      ,de: 'letzte 3 Monate'
      ,fr: '3 derniers mois'
      ,pt: 'Últimos 3 meses'
      }
    ,'From' : {   
      cs: 'Od'
      ,de: 'Von'
      ,fr: 'De'
      ,pt: 'De'
      }
    ,'To' : {   
      cs: 'Do'
      ,de: 'Bis'
      ,fr: 'à'
      ,pt: 'Para'
      }
    ,'Notes' : {   
      cs: 'Poznámky'
      ,de: 'Notiz'
      ,fr: 'Notes'
      ,pt: 'Notas'
      }
    ,'Food' : {   
      cs: 'Jídlo'
      ,de: 'Essen'
      ,fr: 'Nourriture'
      ,pt: 'Comida'
      }
    ,'Insulin' : {   
      cs: 'Inzulín'
      ,de: 'Insulin'
      ,fr: 'Insuline'
      ,pt: 'Insulina'
      }
    ,'Carbs' : {   
      cs: 'Sacharidy'
      ,de: 'Kohlenhydrate'
      ,fr: 'Glucides'
      ,pt: 'Carboidrato'
      }
    ,'Notes contain' : {   
      cs: 'Poznámky obsahují'
      ,de: 'Notizen beinhalten'
      ,fr: 'Notes contiennent'
      ,pt: 'Notas contém'
      }
    ,'Event type contains' : {   
      cs: 'Typ události obsahuje'
      ,de: 'Ereignis-Typ beinhaltet'
      ,fr: 'Type d\'événement contient'
      ,pt: 'Tipo de evento contém'
      }
    ,'Target bg range bottom' : {   
      cs: 'Cílová glykémie spodní'
      ,de: 'Untergrenze des Blutzuckerzielbereichs'
      ,fr: 'Limite inférieure glycémie'
      ,pt: 'Limite inferior de glicemia'
      }
    ,'top' : {   
      cs: 'horní'
      ,de: 'oben'
      ,fr: 'Supérieur'
      ,pt: 'Superior'
      }
    ,'Show' : {   
      cs: 'Zobraz'
      ,de: 'Zeige'
      ,fr: 'Montrer'
      ,pt: 'Mostrar'
      }
    ,'Display' : {   
      cs: 'Zobraz'
      ,de: 'Zeige'
      ,fr: 'Afficher'
      ,pt: 'Mostrar'
      }
    ,'Loading' : {   
      cs: 'Nahrávám'
      ,de: 'Laden'
      ,fr: 'Chargement'
      ,pt: 'Carregando'
      }
    ,'Loading profile' : {   
      cs: 'Nahrávám profil'
      ,de: 'Lade Profil'
      ,fr: 'Chargement du profil'
      ,pt: 'Carregando perfil'
      }
    ,'Loading status' : {   
      cs: 'Nahrávám status'
      ,de: 'Lade Status'
      ,fr: 'Statut du chargement'
      ,pt: 'Carregando status'
      }
    ,'Loading food database' : {   
      cs: 'Nahrávám databázi jídel'
      ,de: 'Lade Essensdatenbank'
      ,fr: 'Chargement de la base de données alimentaire'
      ,pt: 'Carregando dados de alimentos'
      }
    ,'not displayed' : {   
      cs: 'není zobrazeno'
      ,de: 'nicht angezeigt'
      ,fr: 'non affiché'
      ,pt: 'não mostrado'
      }
    ,'Loading CGM data of' : {   
      cs: 'Nahrávám CGM data'
      ,de: 'Lade CGM-Daten von'
      ,fr: 'Chargement données CGM de'
      ,pt: 'Carregando dados de CGM de'
      }
    ,'Loading treatments data of' : {   
      cs: 'Nahrávám data ošetření'
      ,de: 'Lade Behandlungsdaten von'
      ,fr: 'Chargement données traitement de'
      ,pt: 'Carregando dados de tratamento de'
      }
    ,'Processing data of' : {   
      cs: 'Zpracovávám data'
      ,de: 'Verarbeite Daten von'
      ,fr: 'Traitement des données de'
      ,pt: 'Processando dados de'
      }
    ,'Portion' : {   
      cs: 'Porce'
      ,de: 'Portion'
      ,fr: 'Portion'
      ,pt: 'Porção'
      }
    ,'Size' : {   
      cs: 'Rozměr'
      ,de: 'Größe'
      ,fr: 'Taille'
      ,pt: 'Tamanho'
      }
    ,'(none)' : {   
      cs: '(Prázdný)'
      ,de: '(nichts)'
      ,fr: '(aucun)'
      ,pt: '(nenhum)'
      }
    ,'Result is empty' : {   
      cs: 'Prázdný výsledek'
      ,de: 'Leeres Ergebnis'
      ,fr: 'Pas de résultat' 
      ,pt: 'Resultado vazio'
      }
// ported reporting
    ,'Day to day' : {   
      cs: 'Den po dni'
      ,fr: 'jour par jour'
      ,pt: 'Dia a dia'
      }
    ,'Daily Stats' : {   
      cs: 'Denní statistiky'
      ,fr: 'Stats quotidiennes'
      ,pt: 'Estatísticas diárias'
      }
    ,'Percentile Chart' : {   
      cs: 'Percentil'
      ,fr: 'Percentiles'
      ,pt: 'Percentis'
      }
    ,'Distribution' : {   
      cs: 'Rozložení'
      ,fr: 'Distribution'
      ,pt: 'Distribuição'
	  }
    ,'Hourly stats' : {   
      cs: 'Statistika po hodinách'
      ,fr: 'Statistiques horaires'
      ,pt: 'Estatísticas por hora'
	  }
    ,'Weekly success' : {   
      cs: 'Statistika po týdnech'
      ,fr: 'Résultat hebdomadaire'
      ,pt: 'Resultados semanais'
      }
    ,'No data available' : {   
      cs: 'Žádná dostupná data'
      ,fr: 'Pas de données disponibles'
      ,pt: 'Dados indisponíveis'
      }
    ,'Low' : {   
      cs: 'Nízká'
      ,fr: 'Bas'
      ,pt: 'Baixo'
      }
    ,'In Range' : {   
      cs: 'V rozsahu'
      ,fr: 'dans la norme'
      ,pt: 'Na meta'
      }
    ,'Period' : {   
      cs: 'Období'
      ,fr: 'Période'
      ,pt: 'Período'
      }
    ,'High' : {   
      cs: 'Vysoká'
      ,fr: 'Haut'
      ,pt: 'Alto'
      }
    ,'Average' : {   
      cs: 'Průměrná'
      ,fr: 'Moyenne'
      ,pt: 'Média'
      }
    ,'Low Quartile' : {   
      cs: 'Nízký kvartil'
      ,fr: 'Quartile inférieur'
      ,pt: 'Quartil inferior'
      }
    ,'Upper Quartile' : {   
      cs: 'Vysoký kvartil'
      ,fr: 'Quartile supérieur'
      }
    ,'Quartile' : {   
      cs: 'Kvartil'
      ,fr: 'Quartile'
      }
    ,'Date' : {   
      cs: 'Datum'
      ,fr: 'Date'
      }
    ,'Normal' : {   
      cs: 'Normální'
      ,fr: 'Normale'
      }
    ,'Median' : {   
      cs: 'Medián'
      ,fr: 'Médiane'
      }
    ,'Readings' : {   
      cs: 'Záznamů'
      ,fr: 'Valeurs'
      }
    ,'StDev' : {   
      cs: 'St. odchylka'
      ,fr: 'Déviation St.'
      }
    ,'Daily stats report' : {   
      cs: 'Denní statistiky'
      ,fr: 'Rapport quotidien'
      }
    ,'Glucose Percentile report' : {   
      cs: 'Tabulka percentil glykémií'
      ,fr: 'Rapport precentiles Glycémie'
      }
    ,'Glucose distribution' : {   
      cs: 'Rozložení glykémií'
      ,fr: 'Distribution glycémies'
      }
    ,'days total' : {   
      cs: 'dní celkem'
      ,fr: 'jours totaux'
      }
    ,'Overall' : {   
      cs: 'Celkem'
      ,fr: 'Dans l\'ensemble'
      }
    ,'Range' : {   
      cs: 'Rozsah'
      ,fr: 'Intervalle'
      }
    ,'% of Readings' : {   
      cs: '% záznamů'
      }
    ,'# of Readings' : {   
      cs: 'počet záznamů'
      ,fr: 'nbr de valeurs'
      }
    ,'Mean' : {   
      cs: 'Střední hodnota'
      ,fr: 'Moyenne'
      }
    ,'Standard Deviation' : {   
      cs: 'Standardní odchylka'
      ,fr: 'Déviation Standard'
      }
    ,'Max' : {   
      cs: 'Max'
      ,fr: 'Max'
      }
    ,'Min' : {   
      cs: 'Min'
      ,fr: 'Min'
      }
    ,'A1c estimation*' : {   
      cs: 'Předpokládané HBA1c*'
      ,fr: 'Estimation HbA1c*'
      }
    ,'Weekly Success' : {   
      cs: 'Týdenní úspěšnost'
      ,fr: 'Réussite hebdomadaire'
      }
    ,'There is not sufficient data to run this report. Select more days.' : {   
      cs: 'Není dostatek dat. Vyberte delší časové období.'
      ,fr: 'Pas assez de données pour un rapport. Sélectionnez plus de jours.'
	  }
// food editor
    ,'Using stored API secret hash' : {   
      cs: 'Používám uložený hash API hesla'
      ,fr: 'Utilisation du hash API existant'
      }
    ,'No API secret hash stored yet. You need to enter API secret.' : {   
      cs: 'Není uložený žádný hash API hesla. Musíte zadat API heslo.'
      ,fr: 'Pas de secret API existant. Vous devez en entrer un.'
      }
    ,'Database loaded' : {   
      cs: 'Databáze načtena'
      ,fr: 'Base de données chargée'
      }
    ,'Error: Database failed to load' : {   
      cs: 'Chyba při načítání databáze'
      ,fr: 'Erreur, le chargement de la base de données a échoué'
      }
    ,'Create new record' : {   
      cs: 'Vytvořit nový záznam'
      ,fr: 'Créer nouvel enregistrement'
      }
    ,'Save record' : {   
      cs: 'Uložit záznam'
      ,fr: 'Sauver enregistrement'
      }
    ,'Portions' : {   
      cs: 'Porcí'
      ,fr: 'Portions'
      }
    ,'Unit' : {   
      cs: 'Jedn'
      ,fr: 'Unités'
      }
    ,'GI' : {   
      cs: 'GI'
      ,fr: 'IG'
      }
    ,'Edit record' : {   
      cs: 'Upravit záznam'
      ,fr: 'Modifier enregistrement'
      }
    ,'Delete record' : {   
      cs: 'Smazat záznam'
      ,fr: 'Effacer enregistrement'
      }
    ,'Move to the top' : {   
      cs: 'Přesuň na začátek'
      ,fr: 'Déplacer au sommet'
      }
    ,'Hidden' : {   
      cs: 'Skrytý'
      ,fr: 'Caché'
      }
    ,'Hide after use' : {   
      cs: 'Skryj po použití'
      ,fr: 'Cacher après utilisation'
      }
    ,'Your API secret must be at least 12 characters long' : {   
      cs: 'Vaše API heslo musí mít alespoň 12 znaků'
      ,fr: 'Votre secret API doit contenir au moins 12 caractères'
      }
    ,'Bad API secret' : {   
      cs: 'Chybné API heslo'
      ,fr: 'Secret API erroné'
      }
    ,'API secret hash stored' : {   
      cs: 'Hash API hesla uložen'
      ,fr: 'Hash API secret sauvegardé'
      }
    ,'Status' : {   
      cs: 'Status'
      ,fr: 'Statut'
      }
    ,'Not loaded' : {   
      cs: 'Nenačtený'
      ,fr: 'Non chargé'
      }
    ,'Food editor' : {   
      cs: 'Editor jídel'
      ,fr: 'Editeur aliments'
      }
    ,'Your database' : {   
      cs: 'Vaše databáze'
      ,fr: 'Votre base de données'
      }
    ,'Filter' : {   
      cs: 'Filtr'
      ,fr: 'Filtre'
      }
    ,'Save' : {   
      cs: 'Ulož'
      ,fr: 'Sauver'
      }
    ,'Clear' : {   
      cs: 'Vymaž'
      ,fr: 'Effacer'
      }
    ,'Record' : {   
      cs: 'Záznam'
      ,fr: 'Enregistrement'
      }
    ,'Quick picks' : {   
      cs: 'Rychlý výběr'
      ,fr: 'Sélection rapide'
      }
    ,'Show hidden' : {   
      cs: 'Zobraz skryté'
      ,fr: 'Montrer cachés'
      }
    ,'Your API secret' : {   
      cs: 'Vaše API heslo'
      ,fr: 'Votre secret API'
      }
    ,'Store hash on this computer (Use only on private computers)' : {   
      cs: 'Ulož hash na tomto počítači (používejte pouze na soukromých počítačích)'
      ,fr: 'Sauver le hash sur cet ordinateur (privé uniquement)'
      }
    ,'Treatments' : {   
      cs: 'Ošetření'
      ,fr: 'Traitements'
      }
    ,'Time' : {   
      cs: 'Čas'
      ,fr: 'Heure'
      }
    ,'Event Type' : {   
      cs: 'Typ události'
      ,fr: 'Type d\'événement'
      }
    ,'Blood Glucose' : {   
      cs: 'Glykémie'
      ,fr: 'Glycémie'
      }
    ,'Entered By' : {   
      cs: 'Zadal'
      ,fr: 'Entré par'
      }
    ,'Delete this treatment?' : {   
      cs: 'Vymazat toto ošetření?'
      ,fr: 'Effacer ce traitement?'
      }
    ,'Carbs Given' : {   
      cs: 'Sacharidů'
      ,fr: 'Glucides donnés'
      }
    ,'Inzulin Given' : {   
      cs: 'Inzulínu'
      ,fr: 'Insuline donnée'
      }
    ,'Event Time' : {   
      cs: 'Čas události'
      ,fr: 'Heure de l\'événement'
      }
    ,'Please verify that the data entered is correct' : {   
      cs: 'Prosím zkontrolujte, zda jsou údaje zadány správně'
      ,fr: 'Merci de vérifier la correction des données entrées'
      }
    ,'BG' : {   
      cs: 'Glykémie'
      ,fr: 'Glycémie'
      }
    ,'Use BG correction in calculation' : {   
      cs: 'Použij korekci na glykémii'
      ,fr: 'Utiliser la correction de glycémie dans les calculs'
      }
    ,'BG from CGM (autoupdated)' : {   
      cs: 'Glykémie z CGM (automaticky aktualizovaná)'
      ,fr: 'Glycémie CGM (automatique)'
      }
    ,'BG from meter' : {   
      cs: 'Glykémie z glukoměru'
      ,fr: 'Glycémie glucomètre'
      }
    ,'Manual BG' : {   
      cs: 'Ručně zadaná glykémie'
      ,fr: 'Glycémie manuelle'
      }
    ,'Quickpick' : {   
      cs: 'Rychlý výběr'
      ,fr: 'Sélection rapide'
      }
    ,'or' : {   
      cs: 'nebo'
      ,fr: 'ou'
      }
    ,'Add from database' : {   
      cs: 'Přidat z databáze'
      ,fr: 'Ajouter à partir de la base de données'
      }
    ,'Use carbs correction in calculation' : {   
      cs: 'Použij korekci na sacharidy'
      ,fr: 'Utiliser la correction en glucides dans les calculs'
      }
    ,'Use COB correction in calculation' : {   
      cs: 'Použij korekci na COB'
      ,fr: 'Utiliser les COB dans les calculs'
      }
    ,'Use IOB in calculation' : {   
      cs: 'Použij IOB ve výpočtu'
      ,fr: 'Utiliser l\'IOB dans les calculs'
      }
    ,'Other correction' : {   
      cs: 'Jiná korekce'
      ,fr: 'Autre correction'
      }
    ,'Rounding' : {   
      cs: 'Zaokrouhlení'
      ,fr: 'Arrondi'
	  }
    ,'Enter insulin correction in treatment' : {   
      cs: 'Zahrň inzulín do záznamu ošetření'
      ,fr: 'Entrer correction insuline dans le traitement'
      }
    ,'Insulin needed' : {   
      cs: 'Potřebný inzulín'
      ,fr: 'Insuline nécessaire'
      }
    ,'Carbs needed' : {   
      cs: 'Potřebné sach'
      ,fr: 'Glucides nécessaires'
      }
    ,'Carbs needed if Insulin total is negative value' : {   
      cs: 'Chybějící sacharidy v případě, že výsledek je záporný'
      ,fr: 'Glucides nécessaires si insuline totale négative'
      }
    ,'Basal rate' : {   
      cs: 'Bazál'
      ,fr: 'Taux basal'
      }
    ,'Eating' : {   
      cs: 'Jídlo'
      ,fr: 'Repas'
      }
    ,'60 minutes before' : {   
      cs: '60 min předem'
      ,fr: '60 min avant'
      }
    ,'45 minutes before' : {   
      cs: '45 min předem'
      ,fr: '45 min avant'
      }
    ,'30 minutes before' : {   
      cs: '30 min předem'
      ,fr: '30 min avant'
      }
    ,'20 minutes before' : {   
      cs: '20 min předem'
      ,fr: '20 min avant'
      }
    ,'15 minutes before' : {   
      cs: '15 min předem'
      ,fr: '15 min avant'
      }
    ,'Time in minutes' : {   
      cs: 'Čas v minutách'
      ,fr: 'Durée en minutes'
      }
    ,'15 minutes after' : {   
      cs: '15 min po'
      ,fr: '15 min après'
      }
    ,'20 minutes after' : {   
      cs: '20 min po'
      ,fr: '20 min après'
      }
    ,'30 minutes after' : {   
      cs: '30 min po'
      ,fr: '30 min après'
      }
    ,'45 minutes after' : {   
      cs: '45 min po'
      ,fr: '45 min après'
      }
    ,'60 minutes after' : {   
      cs: '60 min po'
      ,fr: '60 min après'
      }
    ,'Additional Notes, Comments' : {   
      cs: 'Dalši poznámky, komentáře'
      ,fr: 'Notes additionnelles, commentaires'
      }
    ,'RETRO MODE' : {   
      cs: 'V MINULOSTI'
      ,fr: 'MODE RETROSPECTIF'
      }
    ,'Now' : {   
      cs: 'Nyní'
      ,fr: 'Maintenant'
      }
    ,'Other' : {   
      cs: 'Jiný'
      ,fr: 'Autre'
      }
    ,'Submit Form' : {   
      cs: 'Odeslat formulář'
      ,fr: 'Formulaire de soumission'
      }
    ,'Profile editor' : {   
      cs: 'Editor profilu'
      ,fr: 'Editeur de profil'
      }
    ,'Reporting tool' : {   
      cs: 'Výkazy'
      ,fr: 'Outil de rapport'
      }
    ,'Add food from your database' : {   
      cs: 'Přidat jidlo z Vaší databáze'
      ,fr: 'Ajouter aliment de votre base de données'
      }
    ,'Reload database' : {   
      cs: 'Znovu nahraj databázi'
      ,fr: 'Recharger la base de données'
      }
    ,'Add' : {   
      cs: 'Přidej'
      ,fr: 'Ajouter'
      }
    ,'Unauthorized' : {   
      cs: 'Neautorizováno'
      ,fr: 'Non autorisé'
      }
    ,'Entering record failed' : {   
      cs: 'Vložení záznamu selhalo'
      ,fr: 'Entrée enregistrement a échoué'
      }
    ,'Device authenticated' : {   
      cs: 'Zařízení ověřeno'
      ,fr: 'Appareil authentifié'
      }
    ,'Device not authenticated' : {   
      cs: 'Zařízení není ověřeno'
      ,fr: 'Appareil non authentifié'
      }
    ,'Authentication status' : {   
      cs: 'Stav ověření'
      ,fr: 'Status de l\'authentification'
      }
    ,'Authenticate' : {   
      cs: 'Ověřit'
      ,fr: 'Authentifier'
      }
    ,'Remove' : {   
      cs: 'Vymazat'
      ,fr: 'Retirer'
      }
    ,'Your device is not authenticated yet' : {   
      cs: 'Toto zařízení nebylo dosud ověřeno'
      ,fr: 'Votre appareil n\'est pas encore authentifié'
      }
    ,'Sensor' : {   
      cs: 'Senzor'
      ,fr: 'Senseur'
      }
    ,'Finger' : {   
      cs: 'Glukoměr'
      ,fr: 'Doigt'
      }
    ,'Manual' : {   
      cs: 'Ručně'
      ,fr: 'Manuel'
      }
    ,'Scale' : {   
      cs: 'Měřítko'
      ,fr: 'Echelle'
      }
    ,'Linear' : {   
      cs: 'lineární'
      ,fr: 'Linéaire'
      }
    ,'Logarithmic' : {   
      cs: 'logaritmické'
      ,fr: 'Logarithmique'
      }
    ,'Silence for 30 minutes' : {   
      cs: 'Ztlumit na 30 minut'
      ,fr: 'Silence pendant 30 minutes'
      }
    ,'Silence for 60 minutes' : {   
      cs: 'Ztlumit na 60 minut'
      ,fr: 'Silence pendant 60 minutes'
      }
    ,'Silence for 90 minutes' : {   
      cs: 'Ztlumit na 90 minut'
      ,fr: 'Silence pendant 90 minutes'
      }
    ,'Silence for 120 minutes' : {   
      cs: 'Ztlumit na 120 minut'
      ,fr: 'Silence pendant 120 minutes'
      }
    ,'3HR' : {   
      cs: '3hod'
      ,fr: '3hr'
      }
    ,'6HR' : {   
      cs: '6hod'
      ,fr: '6hr'
      }
    ,'12HR' : {   
      cs: '12hod'
      ,fr: '12hr'
      }
    ,'24HR' : {   
      cs: '24hod'
      ,fr: '24hr'
      }
    ,'Sttings' : {   
      cs: 'Nastavení'
      ,fr: 'Paramètres'
      }
    ,'Units' : {   
      cs: 'Jednotky'
      ,fr: 'Unités'
      }
    ,'Date format' : {   
      cs: 'Formát datumu'
      ,fr: 'Format Date'
      }
    ,'12 hours' : {   
      cs: '12 hodin'
      ,fr: '12hr'
      }
    ,'24 hours' : {   
      cs: '24 hodin'
      ,fr: '24hr'
      }
    ,'Log a Treatment' : {   
      cs: 'Záznam ošetření'
      ,fr: 'Entrer un traitement'
      }
    ,'BG Check' : {   
      cs: 'Kontrola glykémie'
      ,fr: 'Contrôle glycémie'
      }
    ,'Meal Bolus' : {   
      cs: 'Bolus na jídlo'
      ,fr: 'Bolus repas'
      }
    ,'Snack Bolus' : {   
      cs: 'Bolus na svačinu'
      ,fr: 'Bolus friandise'
      }
    ,'Correction Bolus' : {   
      cs: 'Bolus na glykémii'
      ,fr: 'Bolus de correction'
      }
    ,'Carb Correction' : {   
      cs: 'Přídavek sacharidů'
      ,fr: 'Correction glucide'
      }
    ,'Note' : {   
      cs: 'Poznámka'
      ,fr: 'Note'
      }
    ,'Question' : {   
      cs: 'Otázka'
      ,fr: 'Question'
      }
    ,'Exercise' : {   
      cs: 'Cvičení'
      ,fr: 'Exercice'
      }
    ,'Pump Site Change' : {   
      cs: 'Přepíchnutí kanyly'
      ,fr: 'Changement de site pompe'
      }
    ,'Sensor Start' : {   
      cs: 'Spuštění sensoru'
      ,fr: 'Démarrage senseur'
      }
    ,'Sensor Change' : {   
      cs: 'Výměna sensoru'
      ,fr: 'Changement senseur'
      }
    ,'Dexcom Sensor Start' : {   
      cs: 'Spuštění sensoru'
      ,fr: 'Démarrage senseur Dexcom'
      }
    ,'Dexcom Sensor Change' : {   
      cs: 'Výměna sensoru'
      ,fr: 'Changement senseur Dexcom'
      }
    ,'Insulin Cartridge Change' : {   
      cs: 'Výměna inzulínu'
      ,fr: 'Changement cartouche d\'insuline'
      }
    ,'D.A.D. Alert' : {   
      cs: 'D.A.D. Alert'
      ,fr: 'Wouf! Wouf! Chien d\'alerte diabète'
      }
    ,'Glucose Reading' : {   
      cs: 'Hodnota glykémie'
      ,fr: 'Valeur de glycémie'
      }
    ,'Measurement Method' : {   
      cs: 'Metoda měření'
      ,fr: 'Méthode de mesure'
      }
    ,'Meter' : {   
      cs: 'Glukoměr'
      ,fr: 'Glucomètre'
      }
    ,'Insulin Given' : {   
      cs: 'Inzulín'
      ,fr: 'Insuline donnée'
      }
    ,'Amount in grams' : {   
      cs: 'Množství v gramech'
      ,fr: 'Quantité en grammes'
      }
    ,'Amount in units' : {   
      cs: 'Množství v jednotkách'
      ,fr: 'Quantité en unités'
      }
    ,'View all treatments' : {   
      cs: 'Zobraz všechny ošetření'
      ,fr: 'Voir tous les traitements'
      }
    ,'Enable Alarms' : {   
      cs: 'Povolit alarmy'
      ,fr: 'Activer les alarmes'
      }
    ,'When enabled an alarm may sound.' : {   
      cs: 'Při povoleném alarmu zní zvuk'
      ,fr: 'Si activée, un alarme peut sonner.'
      }
    ,'Urgent High Alarm' : {   
      cs: 'Urgentní vysoká glykémie'
      ,fr: 'Alarme haute urgente'
      }
    ,'High Alarm' : {   
      cs: 'Vysoká glykémie'
      ,fr: 'Alarme haute'
      }
    ,'Low Alarm' : {   
      cs: 'Nízká glykémie'
      ,fr: 'Alarme basse'
      }
    ,'Urgent Low Alarm' : {   
      cs: 'Urgentní nízká glykémie'
      ,fr: 'Alarme basse urgente'
      }
    ,'Stale Data: Warn' : {   
      cs: 'Zastaralá data'
      ,fr: 'Données dépassées'
      }
    ,'Stale Data: Urgent' : {   
      cs: 'Zastaralá data urgentní'
      ,fr: 'Données dépassées urgentes'
      }
    ,'mins' : {   
      cs: 'min'
      ,fr: 'mins'
      }
    ,'Night Mode' : {   
      cs: 'Noční mód'
      ,fr: 'Mode nocturne'
      }
    ,'When enabled the page will be dimmed from 10pm - 6am.' : {   
      cs: 'Když je povoleno, obrazovka je ztlumena 22:00 - 6:00'
      ,fr: 'Si activé, la page sera assombire de 22:00 à 6:00'
      }
    ,'Enable' : {   
      cs: 'Povoleno'
      ,fr: 'activer'
      }
    ,'Settings' : {   
      cs: 'Nastavení'
      ,fr: 'Paramètres'
      }
    ,'Show Raw BG Data' : {   
      cs: 'Zobraz RAW data'
      ,fr: 'Montrer les données BG brutes'
      }
    ,'Never' : {   
      cs: 'Nikdy'
      ,fr: 'Jamais'
      }
    ,'Always' : {   
      cs: 'Vždy'
      ,fr: 'Toujours'
      }
    ,'When there is noise' : {   
      cs: 'Při šumu'
      ,fr: 'Quand il y a du bruit'
      }
    ,'When enabled small white dots will be disaplyed for raw BG data' : {   
      cs: 'Když je povoleno, malé tečky budou zobrazeny pro RAW data'
      ,fr: 'Si activé, des points blancs représenteront les données brutes'
      }
    ,'Custom Title' : {   
      cs: 'Vlastní název stránky'
      ,fr: 'Titre sur mesure'
      }
    ,'Theme' : {   
      cs: 'Téma'
      ,fr: 'Thème'
      }
    ,'Default' : {   
      cs: 'Výchozí'
      ,fr: 'Par défaut'
      }
    ,'Colors' : {   
      cs: 'Barevné'
      ,fr: 'Couleurs'
      }
    ,'Reset, and use defaults' : {   
      cs: 'Vymaž a nastav výchozí hodnoty'
      ,fr: 'Remise à zéro et utilisation des valeurs par défaut'
      }
    ,'Calibrations' : {   
      cs: 'Kalibrace'
      ,fr: 'Calibration'
      }
    ,'Alarm Test / Smartphone Enable' : {   
      cs: 'Test alarmu'
      ,fr: 'Test alarme'
      }
    ,'Bolus Wizard' : {   
      cs: 'Bolusový kalkulátor'
      ,fr: 'Calculateur de bolus'
      }
    ,'in the future' : {   
      cs: 'v budoucnosti'
      ,fr: 'dans le futur'
      }
    ,'time ago' : {   
      cs: 'min zpět'
      ,fr: 'temps avant'
      }
    ,'hr ago' : {   
      cs: 'hod zpět'
      ,fr: 'hr avant'
	  
      }
    ,'hrs ago' : {   
      cs: 'hod zpět'
      ,fr: 'hrs avant'
      }
    ,'min ago' : {   
      cs: 'min zpět'
      ,fr: 'min avant'
      }
    ,'mins ago' : {   
      cs: 'min zpět'
      ,fr: 'mins avant'
      }
    ,'day ago' : {   
      cs: 'den zpět'
      ,fr: 'jour avant'
      }
    ,'days ago' : {   
      cs: 'dnů zpět'
      ,fr: 'jours avant'
      }
    ,'long ago' : {   
      cs: 'dlouho zpět'
      ,fr: 'il y a très longtemps...'
      }
    ,'Clean' : {   
      cs: 'Čistý'
      ,fr: 'Propre'
      }
    ,'Light' : {   
      cs: 'Lehký'
      ,fr: 'Léger'
      }
    ,'Medium' : {   
      cs: 'Střední'
      ,fr: 'Moyen'
      }
    ,'Heavy' : {   
      cs: 'Velký'
      ,fr: 'Important'
      }
    ,'Treatment type' : {   
      cs: 'Typ ošetření'
      ,fr: 'Type de traitement'
      }
    ,'Raw BG' : {   
      cs: 'Glykémie z RAW dat'
      ,fr: 'BG brut'
      }
    ,'Device' : {   
      cs: 'Zařízení'
      ,fr: 'Appareil'
      }
    ,'Noise' : {   
      cs: 'Šum'
      ,fr: 'Bruit'
      }
    ,'Calibration' : {   
      cs: 'Kalibrace'
      ,fr: 'Calibration'
      }
    ,'Show Plugins' : {   
      cs: 'Zobrazuj pluginy'
      }
    ,'About' : {   
      cs: 'O aplikaci'
      }
    ,'Value in' : {   
      cs: 'Hodnota v'
      }
    ,'Prebolus' : {   
      cs: 'Posunuté jídlo'
      }
 
 };
  
 language.translate = function translate(text) {
    if (translations[text] && translations[text][lang]) {
      return translations[text][lang];
    }
    return text;
  };
    
  language.DOMtranslate = function DOMtranslate() {
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
