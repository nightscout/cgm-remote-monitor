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
      ,pt: 'não há dados'
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
      ,pt: 'Quartil superior'
      }
    ,'Quartile' : {   
      cs: 'Kvartil'
      ,fr: 'Quartile'
      ,pt: 'Quartil'
      }
    ,'Date' : {   
      cs: 'Datum'
      ,fr: 'Date'
      ,pt: 'Data'
      }
    ,'Normal' : {   
      cs: 'Normální'
      ,fr: 'Normale'
      ,pt: 'Normal'
      }
    ,'Median' : {   
      cs: 'Medián'
      ,fr: 'Médiane'
      ,pt: 'Mediana'
      }
    ,'Readings' : {   
      cs: 'Záznamů'
      ,fr: 'Valeurs'
      ,pt: 'Valores'
      }
    ,'StDev' : {   
      cs: 'St. odchylka'
      ,fr: 'Déviation St.'
      ,pt: 'DesvPadr'
      }
    ,'Daily stats report' : {   
      cs: 'Denní statistiky'
      ,fr: 'Rapport quotidien'
      ,pt: 'Relatório diário'
      }
    ,'Glucose Percentile report' : {   
      cs: 'Tabulka percentil glykémií'
      ,fr: 'Rapport precentiles Glycémie'
      ,pt: 'Relatório de Percentis de Glicemia'
      }
    ,'Glucose distribution' : {   
      cs: 'Rozložení glykémií'
      ,fr: 'Distribution glycémies'
      ,pt: 'Distribuição de glicemias'
      }
    ,'days total' : {   
      cs: 'dní celkem'
      ,fr: 'jours totaux'
      ,pt: 'dias total'
      }
    ,'Overall' : {   
      cs: 'Celkem'
      ,fr: 'Dans l\'ensemble'
      ,pt: 'Geral'
      }
    ,'Range' : {   
      cs: 'Rozsah'
      ,fr: 'Intervalle'
      ,pt: 'intervalo'
      }
    ,'% of Readings' : {   
      cs: '% záznamů'
      ,pt: '% de valores'
      }
    ,'# of Readings' : {   
      cs: 'počet záznamů'
      ,fr: 'nbr de valeurs'
      ,pt: 'N° de valores'
      }
    ,'Mean' : {   
      cs: 'Střední hodnota'
      ,fr: 'Moyenne'
      ,pt: 'Média'
      }
    ,'Standard Deviation' : {   
      cs: 'Standardní odchylka'
      ,fr: 'Déviation Standard'
      ,pt: 'Desvio padrão'
      }
    ,'Max' : {   
      cs: 'Max'
      ,fr: 'Max'
      ,pt: 'Max'
      }
    ,'Min' : {   
      cs: 'Min'
      ,fr: 'Min'
      ,pt: 'Min'
      }
    ,'A1c estimation*' : {   
      cs: 'Předpokládané HBA1c*'
      ,fr: 'Estimation HbA1c*'
      ,pt: 'A1c estimada'
      }
    ,'Weekly Success' : {   
      cs: 'Týdenní úspěšnost'
      ,fr: 'Réussite hebdomadaire'
      ,pt: 'Resultados semanais'
      }
    ,'There is not sufficient data to run this report. Select more days.' : {   
      cs: 'Není dostatek dat. Vyberte delší časové období.'
      ,fr: 'Pas assez de données pour un rapport. Sélectionnez plus de jours.'
      ,pt: 'Não há dados suficientes. Selecione mais dias'
	  }
// food editor
    ,'Using stored API secret hash' : {   
      cs: 'Používám uložený hash API hesla'
      ,fr: 'Utilisation du hash API existant'
      ,pt: 'Usando o hash de API existente'
      }
    ,'No API secret hash stored yet. You need to enter API secret.' : {   
      cs: 'Není uložený žádný hash API hesla. Musíte zadat API heslo.'
      ,fr: 'Pas de secret API existant. Vous devez en entrer un.'
      ,pt: 'Hash de segredo de API inexistente. Entre um segredo de API'
      }
    ,'Database loaded' : {   
      cs: 'Databáze načtena'
      ,fr: 'Base de données chargée'
      ,pt: 'Banco de dados carregado'
      }
    ,'Error: Database failed to load' : {   
      cs: 'Chyba při načítání databáze'
      ,fr: 'Erreur, le chargement de la base de données a échoué'
      ,pt: 'Erro: Banco de dados não carregado'
      }
    ,'Create new record' : {   
      cs: 'Vytvořit nový záznam'
      ,fr: 'Créer nouvel enregistrement'
      ,pt: 'Criar novo registro'
      }
    ,'Save record' : {   
      cs: 'Uložit záznam'
      ,fr: 'Sauver enregistrement'
      ,pt: 'Salvar registro'
      }
    ,'Portions' : {   
      cs: 'Porcí'
      ,fr: 'Portions'
      ,pt: 'Porções'
      }
    ,'Unit' : {   
      cs: 'Jedn'
      ,fr: 'Unités'
      ,pt: 'Unidade'
      }
    ,'GI' : {   
      cs: 'GI'
      ,fr: 'IG'
      ,pt: 'IG'
      }
    ,'Edit record' : {   
      cs: 'Upravit záznam'
      ,fr: 'Modifier enregistrement'
      ,pt: 'Editar registro'
      }
    ,'Delete record' : {   
      cs: 'Smazat záznam'
      ,fr: 'Effacer enregistrement'
      ,pt: 'Apagar registro'
      }
    ,'Move to the top' : {   
      cs: 'Přesuň na začátek'
      ,fr: 'Déplacer au sommet'
      ,pt: 'Mover para o topo'
      }
    ,'Hidden' : {   
      cs: 'Skrytý'
      ,fr: 'Caché'
      ,pt: 'Oculto'
      }
    ,'Hide after use' : {   
      cs: 'Skryj po použití'
      ,fr: 'Cacher après utilisation'
      ,pt: 'Ocultar após uso'
      }
    ,'Your API secret must be at least 12 characters long' : {   
      cs: 'Vaše API heslo musí mít alespoň 12 znaků'
      ,fr: 'Votre secret API doit contenir au moins 12 caractères'
      ,pt: 'Seu segredo de API deve conter no mínimo 12 caracteres'
      }
    ,'Bad API secret' : {   
      cs: 'Chybné API heslo'
      ,fr: 'Secret API erroné'
      ,pt: 'Segredo de API fraco'
      }
    ,'API secret hash stored' : {   
      cs: 'Hash API hesla uložen'
      ,fr: 'Hash API secret sauvegardé'
      ,pt: 'Segredo de API guardado'
      }
    ,'Status' : {   
      cs: 'Status'
      ,fr: 'Statut'
      ,pt: 'Status'
      }
    ,'Not loaded' : {   
      cs: 'Nenačtený'
      ,fr: 'Non chargé'
      ,pt: 'Não carregado'
      }
    ,'Food editor' : {   
      cs: 'Editor jídel'
      ,fr: 'Editeur aliments'
      ,pt: 'Editor de alimentos'
      }
    ,'Your database' : {   
      cs: 'Vaše databáze'
      ,fr: 'Votre base de données'
      ,pt: 'Seu banco de dados'
      }
    ,'Filter' : {   
      cs: 'Filtr'
      ,fr: 'Filtre'
      ,pt: 'Filtro'
      }
    ,'Save' : {   
      cs: 'Ulož'
      ,fr: 'Sauver'
      ,pt: 'Salvar'
      }
    ,'Clear' : {   
      cs: 'Vymaž'
      ,fr: 'Effacer'
      ,pt: 'Apagar'
      }
    ,'Record' : {   
      cs: 'Záznam'
      ,fr: 'Enregistrement'
      ,pt: 'Gravar'
      }
    ,'Quick picks' : {   
      cs: 'Rychlý výběr'
      ,fr: 'Sélection rapide'
      ,pt: 'Seleção rápida'
      }
    ,'Show hidden' : {   
      cs: 'Zobraz skryté'
      ,fr: 'Montrer cachés'
      ,pt: 'Mostrar ocultos'
      }
    ,'Your API secret' : {   
      cs: 'Vaše API heslo'
      ,fr: 'Votre secret API'
      ,pt: 'Seu segredo de API'
      }
    ,'Store hash on this computer (Use only on private computers)' : {   
      cs: 'Ulož hash na tomto počítači (používejte pouze na soukromých počítačích)'
      ,fr: 'Sauver le hash sur cet ordinateur (privé uniquement)'
      ,pt: 'Salvar hash nesse computador (Somente em computadores privados)'
      }
    ,'Treatments' : {   
      cs: 'Ošetření'
      ,fr: 'Traitements'
      ,pt: 'Tratamentos'
      }
    ,'Time' : {   
      cs: 'Čas'
      ,fr: 'Heure'
      ,pt: 'Hora'
      }
    ,'Event Type' : {   
      cs: 'Typ události'
      ,fr: 'Type d\'événement'
      ,pt: 'Tipo de evento'
      }
    ,'Blood Glucose' : {   
      cs: 'Glykémie'
      ,fr: 'Glycémie'
      ,pt: 'Glicemia'
      }
    ,'Entered By' : {   
      cs: 'Zadal'
      ,fr: 'Entré par'
      ,pt: 'Inserido por'
      }
    ,'Delete this treatment?' : {   
      cs: 'Vymazat toto ošetření?'
      ,fr: 'Effacer ce traitement?'
      ,pt: 'Apagar este tratamento'
      }
    ,'Carbs Given' : {   
      cs: 'Sacharidů'
      ,fr: 'Glucides donnés'
      ,pt: 'Carboidratos'
      }
    ,'Inzulin Given' : {   
      cs: 'Inzulínu'
      ,fr: 'Insuline donnée'
      ,pt: 'Insulina'
      }
    ,'Event Time' : {   
      cs: 'Čas události'
      ,fr: 'Heure de l\'événement'
      ,pt: 'Hora do evento'
      }
    ,'Please verify that the data entered is correct' : {   
      cs: 'Prosím zkontrolujte, zda jsou údaje zadány správně'
      ,fr: 'Merci de vérifier la correction des données entrées'
      ,pt: 'Favor verificar se os dados estão corretos'
      }
    ,'BG' : {   
      cs: 'Glykémie'
      ,fr: 'Glycémie'
      ,pt: 'Glicemia'
      }
    ,'Use BG correction in calculation' : {   
      cs: 'Použij korekci na glykémii'
      ,fr: 'Utiliser la correction de glycémie dans les calculs'
      ,pt: 'Usar correção de glicemia nos cálculos'
      }
    ,'BG from CGM (autoupdated)' : {   
      cs: 'Glykémie z CGM (automaticky aktualizovaná)'
      ,fr: 'Glycémie CGM (automatique)'
      ,pt: 'Glicemia do sensor (Automático)'
      }
    ,'BG from meter' : {   
      cs: 'Glykémie z glukoměru'
      ,fr: 'Glycémie glucomètre'
      ,pt: 'Glicemia do glicosímetro'
      }
    ,'Manual BG' : {   
      cs: 'Ručně zadaná glykémie'
      ,fr: 'Glycémie manuelle'
      ,pt: 'Glicemia Manual'
      }
    ,'Quickpick' : {   
      cs: 'Rychlý výběr'
      ,fr: 'Sélection rapide'
      ,pt: 'Seleção rápida'
      }
    ,'or' : {   
      cs: 'nebo'
      ,fr: 'ou'
      ,pt: 'or'
      }
    ,'Add from database' : {   
      cs: 'Přidat z databáze'
      ,fr: 'Ajouter à partir de la base de données'
      ,pt: 'Adicionar do banco de dados'
      }
    ,'Use carbs correction in calculation' : {   
      cs: 'Použij korekci na sacharidy'
      ,fr: 'Utiliser la correction en glucides dans les calculs'
      ,pt: 'Usar correção com carboidratos no cálculo'
      }
    ,'Use COB correction in calculation' : {   
      cs: 'Použij korekci na COB'
      ,fr: 'Utiliser les COB dans les calculs'
      ,pt: 'Usar COB no cálculo'
      }
    ,'Use IOB in calculation' : {   
      cs: 'Použij IOB ve výpočtu'
      ,fr: 'Utiliser l\'IOB dans les calculs'
      ,pt: 'Usar IOB no cálculo'
      }
    ,'Other correction' : {   
      cs: 'Jiná korekce'
      ,fr: 'Autre correction'
      ,pt: 'Outra correção'
      }
    ,'Rounding' : {   
      cs: 'Zaokrouhlení'
      ,fr: 'Arrondi'
      ,pt: 'Arredondamento'
	  }
    ,'Enter insulin correction in treatment' : {   
      cs: 'Zahrň inzulín do záznamu ošetření'
      ,fr: 'Entrer correction insuline dans le traitement'
      ,pt: 'Inserir correção de insulina no tratamento'
      }
    ,'Insulin needed' : {   
      cs: 'Potřebný inzulín'
      ,fr: 'Insuline nécessaire'
      ,pt: 'Insulina necessária'
      }
    ,'Carbs needed' : {   
      cs: 'Potřebné sach'
      ,fr: 'Glucides nécessaires'
      ,pt: 'Carboidratos necessários'
      }
    ,'Carbs needed if Insulin total is negative value' : {   
      cs: 'Chybějící sacharidy v případě, že výsledek je záporný'
      ,fr: 'Glucides nécessaires si insuline totale négative'
      ,pt: 'Carboidratos necessários se Insulina total for negativa'
      }
    ,'Basal rate' : {   
      cs: 'Bazál'
      ,fr: 'Taux basal'
      ,pt: 'Taxa basal'
      }
    ,'Eating' : {   
      cs: 'Jídlo'
      ,fr: 'Repas'
      ,pt: 'Comendo'
      }
    ,'60 minutes before' : {   
      cs: '60 min předem'
      ,fr: '60 min avant'
      ,pt: '60 min antes'
      }
    ,'45 minutes before' : {   
      cs: '45 min předem'
      ,fr: '45 min avant'
      ,pt: '45 min antes'
      }
    ,'30 minutes before' : {   
      cs: '30 min předem'
      ,fr: '30 min avant'
      ,pt: '30 min antes'
      }
    ,'20 minutes before' : {   
      cs: '20 min předem'
      ,fr: '20 min avant'
      ,pt: '20 min antes'
      }
    ,'15 minutes before' : {   
      cs: '15 min předem'
      ,fr: '15 min avant'
      ,pt: '15 min antes'
      }
    ,'Time in minutes' : {   
      cs: 'Čas v minutách'
      ,fr: 'Durée en minutes'
      ,pt: 'Tempo em minutos'
      }
    ,'15 minutes after' : {   
      cs: '15 min po'
      ,fr: '15 min après'
      }
    ,'20 minutes after' : {   
      cs: '20 min po'
      ,fr: '20 min après'
      ,pt: '20 min depois'
      }
    ,'30 minutes after' : {   
      cs: '30 min po'
      ,fr: '30 min après'
      ,pt: '30 min depois'
      }
    ,'45 minutes after' : {   
      cs: '45 min po'
      ,fr: '45 min après'
      ,pt: '45 min depois'
      }
    ,'60 minutes after' : {   
      cs: '60 min po'
      ,fr: '60 min après'
      ,pt: '60 min depois'
      }
    ,'Additional Notes, Comments' : {   
      cs: 'Dalši poznámky, komentáře'
      ,fr: 'Notes additionnelles, commentaires'
      ,pt: 'Notas adicionais e comentários'
      }
    ,'RETRO MODE' : {   
      cs: 'V MINULOSTI'
      ,fr: 'MODE RETROSPECTIF'
      ,pt: 'Modo Retrospectivo'
      }
    ,'Now' : {   
      cs: 'Nyní'
      ,fr: 'Maintenant'
      ,pt: 'Agora'
      }
    ,'Other' : {   
      cs: 'Jiný'
      ,fr: 'Autre'
      ,pt: 'Outro'
      }
    ,'Submit Form' : {   
      cs: 'Odeslat formulář'
      ,fr: 'Formulaire de soumission'
      ,pt: 'Submeter formulário'
      }
    ,'Profile editor' : {   
      cs: 'Editor profilu'
      ,fr: 'Editeur de profil'
      ,pt: 'Editor de perfil'
      }
    ,'Reporting tool' : {   
      cs: 'Výkazy'
      ,fr: 'Outil de rapport'
      ,pt: 'Ferramenta de relatórios'
      }
    ,'Add food from your database' : {   
      cs: 'Přidat jidlo z Vaší databáze'
      ,fr: 'Ajouter aliment de votre base de données'
      ,pt: 'Incluir alimento do seu banco de dados'
      }
    ,'Reload database' : {   
      cs: 'Znovu nahraj databázi'
      ,fr: 'Recharger la base de données'
      ,pt: 'Recarregar banco de dados'
      }
    ,'Add' : {   
      cs: 'Přidej'
      ,fr: 'Ajouter'
      ,pt: 'Adicionar'
      }
    ,'Unauthorized' : {   
      cs: 'Neautorizováno'
      ,fr: 'Non autorisé'
      ,pt: 'Não autorizado'
      }
    ,'Entering record failed' : {   
      cs: 'Vložení záznamu selhalo'
      ,fr: 'Entrée enregistrement a échoué'
      ,pt: 'Entrada de registro falhou'
      }
    ,'Device authenticated' : {   
      cs: 'Zařízení ověřeno'
      ,fr: 'Appareil authentifié'
      ,pt: 'Dispositivo autenticado'
      }
    ,'Device not authenticated' : {   
      cs: 'Zařízení není ověřeno'
      ,fr: 'Appareil non authentifié'
      ,pt: 'Dispositivo não autenticado'
      }
    ,'Authentication status' : {   
      cs: 'Stav ověření'
      ,fr: 'Status de l\'authentification'
      ,pt: 'Status de autenticação'
      }
    ,'Authenticate' : {   
      cs: 'Ověřit'
      ,fr: 'Authentifier'
      ,pt: 'Autenticar'
      }
    ,'Remove' : {   
      cs: 'Vymazat'
      ,fr: 'Retirer'
      ,pt: 'Remover'
      }
    ,'Your device is not authenticated yet' : {   
      cs: 'Toto zařízení nebylo dosud ověřeno'
      ,fr: 'Votre appareil n\'est pas encore authentifié'
      ,pt: 'Seu dispositivo ainda não foi autenticado'
      }
    ,'Sensor' : {   
      cs: 'Senzor'
      ,fr: 'Senseur'
      ,pt: 'Sensor'
      }
    ,'Finger' : {   
      cs: 'Glukoměr'
      ,fr: 'Doigt'
      ,pt: 'Dedo'
      }
    ,'Manual' : {   
      cs: 'Ručně'
      ,fr: 'Manuel'
      ,pt: 'Manual'
      }
    ,'Scale' : {   
      cs: 'Měřítko'
      ,fr: 'Echelle'
      ,pt: 'Escala'
      }
    ,'Linear' : {   
      cs: 'lineární'
      ,fr: 'Linéaire'
      ,pt: 'Linear'
      }
    ,'Logarithmic' : {   
      cs: 'logaritmické'
      ,fr: 'Logarithmique'
      ,pt: 'Logarítmica'
      }
    ,'Silence for 30 minutes' : {   
      cs: 'Ztlumit na 30 minut'
      ,fr: 'Silence pendant 30 minutes'
      ,pt: 'Silenciar por 30 minutos'
      }
    ,'Silence for 60 minutes' : {   
      cs: 'Ztlumit na 60 minut'
      ,fr: 'Silence pendant 60 minutes'
      ,pt: 'Silenciar por 60 minutos'
      }
    ,'Silence for 90 minutes' : {   
      cs: 'Ztlumit na 90 minut'
      ,fr: 'Silence pendant 90 minutes'
      ,pt: 'Silenciar por 90 minutos'
      }
    ,'Silence for 120 minutes' : {   
      cs: 'Ztlumit na 120 minut'
      ,fr: 'Silence pendant 120 minutes'
      ,pt: 'Silenciar por 120 minutos'
      }
    ,'3HR' : {   
      cs: '3hod'
      ,fr: '3hr'
      ,pr: '3h'
      }
    ,'6HR' : {   
      cs: '6hod'
      ,fr: '6hr'
      ,pr: '6h'
      }
    ,'12HR' : {   
      cs: '12hod'
      ,fr: '12hr'
      ,pr: '12h'
      }
    ,'24HR' : {   
      cs: '24hod'
      ,fr: '24hr'
      ,pr: '24h'
      }
    ,'Sttings' : {   
      cs: 'Nastavení'
      ,fr: 'Paramètres'
      ,pr: 'Definições'
      }
    ,'Units' : {   
      cs: 'Jednotky'
      ,fr: 'Unités'
      ,pr: 'Unidades'
      }
    ,'Date format' : {   
      cs: 'Formát datumu'
      ,fr: 'Format Date'
      ,pr: 'Formato de data'
      }
    ,'12 hours' : {   
      cs: '12 hodin'
      ,fr: '12hr'
      ,pr: '12 horas'
      }
    ,'24 hours' : {   
      cs: '24 hodin'
      ,fr: '24hr'
      ,pr: '24 horas'
      }
    ,'Log a Treatment' : {   
      cs: 'Záznam ošetření'
      ,fr: 'Entrer un traitement'
      ,pr: 'Entre um tratamento'
      }
    ,'BG Check' : {   
      cs: 'Kontrola glykémie'
      ,fr: 'Contrôle glycémie'
      ,pr: 'Medida de glicemia'
      }
    ,'Meal Bolus' : {   
      cs: 'Bolus na jídlo'
      ,fr: 'Bolus repas'
      ,pr: 'Bolus de refeição'
      }
    ,'Snack Bolus' : {   
      cs: 'Bolus na svačinu'
      ,fr: 'Bolus friandise'
      ,pr: 'Bolus de lanche'
      }
    ,'Correction Bolus' : {   
      cs: 'Bolus na glykémii'
      ,fr: 'Bolus de correction'
      ,pr: 'Bolus de correção'
      }
    ,'Carb Correction' : {   
      cs: 'Přídavek sacharidů'
      ,fr: 'Correction glucide'
      ,pr: 'Carboidrato de correção'
      }
    ,'Note' : {   
      cs: 'Poznámka'
      ,fr: 'Note'
      ,pr: 'Nota'
      }
    ,'Question' : {   
      cs: 'Otázka'
      ,fr: 'Question'
      ,pr: 'Pergunta'
      }
    ,'Exercise' : {   
      cs: 'Cvičení'
      ,fr: 'Exercice'
      ,pr: 'Exercício'
      }
    ,'Pump Site Change' : {   
      cs: 'Přepíchnutí kanyly'
      ,fr: 'Changement de site pompe'
      ,pr: 'Troca de catéter'
      }
    ,'Sensor Start' : {   
      cs: 'Spuštění sensoru'
      ,fr: 'Démarrage senseur'
      ,pr: 'Início de sensor'
      }
    ,'Sensor Change' : {   
      cs: 'Výměna sensoru'
      ,fr: 'Changement senseur'
      ,pr: 'Troca de sensor'
      }
    ,'Dexcom Sensor Start' : {   
      cs: 'Spuštění sensoru'
      ,fr: 'Démarrage senseur Dexcom'
      ,pr: 'Início de sensor Dexcom'
      }
    ,'Dexcom Sensor Change' : {   
      cs: 'Výměna sensoru'
      ,fr: 'Changement senseur Dexcom'
      ,pr: 'Troca de sensor Dexcom'
      }
    ,'Insulin Cartridge Change' : {   
      cs: 'Výměna inzulínu'
      ,fr: 'Changement cartouche d\'insuline'
      ,pr: 'Troca de reservatório de insulina'
      }
    ,'D.A.D. Alert' : {   
      cs: 'D.A.D. Alert'
      ,fr: 'Wouf! Wouf! Chien d\'alerte diabète'
      ,pr: 'Alerta de cão sentinela de diabetes'
      }
    ,'Glucose Reading' : {   
      cs: 'Hodnota glykémie'
      ,fr: 'Valeur de glycémie'
      ,pr: 'Valor de glicemia'
      }
    ,'Measurement Method' : {   
      cs: 'Metoda měření'
      ,fr: 'Méthode de mesure'
      ,pr: 'Método de medida'
      }
    ,'Meter' : {   
      cs: 'Glukoměr'
      ,fr: 'Glucomètre'
      ,pr: 'Glicosímetro'
      }
    ,'Insulin Given' : {   
      cs: 'Inzulín'
      ,fr: 'Insuline donnée'
      ,pr: 'Insulina'
      }
    ,'Amount in grams' : {   
      cs: 'Množství v gramech'
      ,fr: 'Quantité en grammes'
      ,pr: 'Quantidade em gramas'
      }
    ,'Amount in units' : {   
      cs: 'Množství v jednotkách'
      ,fr: 'Quantité en unités'
      ,pr: 'Quantidade em unidades'
      }
    ,'View all treatments' : {   
      cs: 'Zobraz všechny ošetření'
      ,fr: 'Voir tous les traitements'
      ,pr: 'Visualizar todos os tratamentos'
      }
    ,'Enable Alarms' : {   
      cs: 'Povolit alarmy'
      ,fr: 'Activer les alarmes'
      ,pr: 'Ativar alarmes'
      }
    ,'When enabled an alarm may sound.' : {   
      cs: 'Při povoleném alarmu zní zvuk'
      ,fr: 'Si activée, un alarme peut sonner.'
      ,pr: 'Quando ativado, um alarme poderá soar'
      }
    ,'Urgent High Alarm' : {   
      cs: 'Urgentní vysoká glykémie'
      ,fr: 'Alarme haute urgente'
      ,pr: 'Alarme de alto urgente'
      }
    ,'High Alarm' : {   
      cs: 'Vysoká glykémie'
      ,fr: 'Alarme haute'
      ,pr: 'Alarme de alto'
      }
    ,'Low Alarm' : {   
      cs: 'Nízká glykémie'
      ,fr: 'Alarme basse'
      ,pr: 'Alarme de baixo'
      }
    ,'Urgent Low Alarm' : {   
      cs: 'Urgentní nízká glykémie'
      ,fr: 'Alarme basse urgente'
      ,pr: 'Alarme de baixo urgente'
      }
    ,'Stale Data: Warn' : {   
      cs: 'Zastaralá data'
      ,fr: 'Données dépassées'
      ,pr: 'Dados antigos: aviso'
      }
    ,'Stale Data: Urgent' : {   
      cs: 'Zastaralá data urgentní'
      ,fr: 'Données dépassées urgentes'
      ,pr: 'Dados antigos: Urgente'
      }
    ,'mins' : {   
      cs: 'min'
      ,fr: 'mins'
      ,pr: 'min'
      }
    ,'Night Mode' : {   
      cs: 'Noční mód'
      ,fr: 'Mode nocturne'
      ,pr: 'Modo noturno'
      }
    ,'When enabled the page will be dimmed from 10pm - 6am.' : {   
      cs: 'Když je povoleno, obrazovka je ztlumena 22:00 - 6:00'
      ,fr: 'Si activé, la page sera assombire de 22:00 à 6:00'
      ,pr: 'Se ativado, a página será escurecida de 22h a 6h'
      }
    ,'Enable' : {   
      cs: 'Povoleno'
      ,fr: 'activer'
      ,pr: 'Ativar'
      }
    ,'Settings' : {   
      cs: 'Nastavení'
      ,fr: 'Paramètres'
      ,pr: 'Definições'
      }
    ,'Show Raw BG Data' : {   
      cs: 'Zobraz RAW data'
      ,fr: 'Montrer les données BG brutes'
      ,pr: 'Mostrar dados de glicemia não processados'
      }
    ,'Never' : {   
      cs: 'Nikdy'
      ,fr: 'Jamais'
      ,pr: 'Nunca'
      }
    ,'Always' : {   
      cs: 'Vždy'
      ,fr: 'Toujours'
      ,pr: 'Sempre'
      }
    ,'When there is noise' : {   
      cs: 'Při šumu'
      ,fr: 'Quand il y a du bruit'
      ,pr: 'Quando houver ruído'
      }
    ,'When enabled small white dots will be disaplyed for raw BG data' : {   
      cs: 'Když je povoleno, malé tečky budou zobrazeny pro RAW data'
      ,fr: 'Si activé, des points blancs représenteront les données brutes'
      ,pr: 'Se ativado, pontinhos brancos representarão os dados de glicemia não processados'
      }
    ,'Custom Title' : {   
      cs: 'Vlastní název stránky'
      ,fr: 'Titre sur mesure'
      ,pr: 'Customizar Título'
      }
    ,'Theme' : {   
      cs: 'Téma'
      ,fr: 'Thème'
      ,pr: 'tema'
      }
    ,'Default' : {   
      cs: 'Výchozí'
      ,fr: 'Par défaut'
      ,pr: 'Padrão'
      }
    ,'Colors' : {   
      cs: 'Barevné'
      ,fr: 'Couleurs'
      ,pr: 'Cores'
      }
    ,'Reset, and use defaults' : {   
      cs: 'Vymaž a nastav výchozí hodnoty'
      ,fr: 'Remise à zéro et utilisation des valeurs par défaut'
      ,pr: 'Zerar e usar padrões'
      }
    ,'Calibrations' : {   
      cs: 'Kalibrace'
      ,fr: 'Calibration'
      ,pr: 'Calibraçôes'
      }
    ,'Alarm Test / Smartphone Enable' : {   
      cs: 'Test alarmu'
      ,fr: 'Test alarme'
      ,pr: 'Testar Alarme / Ativar Smartphone'
      }
    ,'Bolus Wizard' : {   
      cs: 'Bolusový kalkulátor'
      ,fr: 'Calculateur de bolus'
      ,pr: 'Bolus Wizard'
      }
    ,'in the future' : {   
      cs: 'v budoucnosti'
      ,fr: 'dans le futur'
      ,pr: 'no futuro'
      }
    ,'time ago' : {   
      cs: 'min zpět'
      ,fr: 'temps avant'
      ,pr: 'tempo atrás'
      }
    ,'hr ago' : {   
      cs: 'hod zpět'
      ,fr: 'hr avant'
      ,pr: 'h atrás'
	  
      }
    ,'hrs ago' : {   
      cs: 'hod zpět'
      ,fr: 'hrs avant'
      ,pr: 'h atrás'
      }
    ,'min ago' : {   
      cs: 'min zpět'
      ,fr: 'min avant'
      ,pr: 'min atrás'
      }
    ,'mins ago' : {   
      cs: 'min zpět'
      ,fr: 'mins avant'
      ,pr: 'min atrás'
      }
    ,'day ago' : {   
      cs: 'den zpět'
      ,fr: 'jour avant'
      ,pr: 'dia atrás'
      }
    ,'days ago' : {   
      cs: 'dnů zpět'
      ,fr: 'jours avant'
      ,pr: 'dias atrás'
      }
    ,'long ago' : {   
      cs: 'dlouho zpět'
      ,fr: 'il y a très longtemps...'
      ,pr: 'muito tempo atrás'
      }
    ,'Clean' : {   
      cs: 'Čistý'
      ,fr: 'Propre'
      ,pr: 'Limpo'
      }
    ,'Light' : {   
      cs: 'Lehký'
      ,fr: 'Léger'
      ,pr: 'Leve'
      }
    ,'Medium' : {   
      cs: 'Střední'
      ,fr: 'Moyen'
      ,pr: 'Médio'
      }
    ,'Heavy' : {   
      cs: 'Velký'
      ,fr: 'Important'
      ,pr: 'Pesado'
      }
    ,'Treatment type' : {   
      cs: 'Typ ošetření'
      ,fr: 'Type de traitement'
      ,pr: 'Tipo de tratamento'
      }
    ,'Raw BG' : {   
      cs: 'Glykémie z RAW dat'
      ,fr: 'BG brut'
      ,pr: 'Glicemia sem processamento'
      }
    ,'Device' : {   
      cs: 'Zařízení'
      ,fr: 'Appareil'
      ,pr: 'Dispositivo'
      }
    ,'Noise' : {   
      cs: 'Šum'
      ,fr: 'Bruit'
      ,pr: 'Ruído'
      }
    ,'Calibration' : {   
      cs: 'Kalibrace'
      ,fr: 'Calibration'
      ,pr: 'Calibração'
      }
    ,'Show Plugins' : {   
      cs: 'Zobrazuj pluginy'
      ,pr: 'Mostrar Plugins'
      }
    ,'About' : {   
      cs: 'O aplikaci'
      ,pr: 'Sobre'
      }
    ,'Value in' : {   
      cs: 'Hodnota v'
      ,pr: 'Valor em'
      }
    ,'Prebolus' : {   
      cs: 'Posunuté jídlo'
      ,pr: 'Pré-bolus'
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
