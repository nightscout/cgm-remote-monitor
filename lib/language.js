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
      ,sv: 'Lyssnar på port'
      ,ro: 'Activ pe portul'
      }
    // Client
    ,'Mo' : {
      cs: 'Po'
      ,de: 'Mo'
      ,fr: 'Lu'
      ,pt: 'Seg'
      ,sv: 'Mån'
      ,ro: 'Lu'
      }
    ,'Tu' : {
      cs: 'Út'
      ,de: 'Di'
      ,fr: 'Ma'
      ,pt: 'Ter'
      ,sv: 'Tis'
      ,ro: 'Ma'
      },
    ',We' : {
      cs: 'St'
      ,de: 'Mi'
      ,fr: 'Me'
      ,pt: 'Qua'
      ,sv: 'Ons'
      ,ro: 'Mie'
      }
    ,'Th' : {
      cs: 'Ct'
      ,de: 'Do'
      ,fr: 'Je'
      ,pt: 'Qui'
      ,sv: 'Tor'
      ,ro: 'Jo'
      }
    ,'Fr' : {
      cs: 'Pá'
      ,de: 'Fr'
      ,fr: 'Ve'
      ,pt: 'Sex'
      ,sv: 'Fre'
      ,ro: 'Vi'
      }
    ,'Sa' : {
      cs: 'So'
      ,de: 'Sa'
      ,fr: 'Sa'
      ,pt: 'Sa'
      ,sv: 'Lör'
      ,ro: 'Sa'
      }
    ,'Su' : {
      cs: 'Ne'
      ,de: 'So'
      ,fr: 'Di'
      ,pt: 'Dom'
      ,sv: 'Sön'
      ,ro: 'Du'
      }
    ,'Monday' : {
      cs: 'Pondelí'
      ,de: 'Montag'
      ,fr: 'Lundi'
      ,pt: 'Segunda'
      ,sv: 'Måndag'
      ,ro: 'Luni'
      }
    ,'Tuesday' : {
      cs: 'Úterý'
      ,de: 'Dienstag'
      ,fr: 'Mardi'
      ,pt: 'Terça'
      ,sv: 'Tisdag'
      ,ro: 'Mar?i'
      }
    ,'Wednesday' : {
      cs: 'Streda'
      ,de: 'Mittwoch'
      ,fr: 'Mercredi'
      ,pt: 'Quarta'
      ,sv: 'Onsdag'
      ,ro: 'Miercuri'
      }
    ,'Thursday' : {
      cs: 'Ctvrtek'
      ,de: 'Donnerstag'
      ,fr: 'Jeudi'
      ,pt: 'Quinta'
      ,sv: 'Torsdag'
      ,ro: 'Joi'
      }
    ,'Friday' : {
      cs: 'Pátek'
      ,de: 'Freitag'
      ,fr: 'Vendredi'
      ,pt: 'Sexta'
      ,sv: 'Fredag'
      ,ro: 'Vineri'
      }
    ,'Saturday' : {
      cs: 'Sobota'
      ,de: 'Samstag'
      ,fr: 'Samedi'
      ,pt: 'Sábado'
      ,sv: 'Lördag'
      ,ro: 'Sâmbata'
      }
    ,'Sunday' : {
      cs: 'Nedele'
      ,de: 'Sonntag'
      ,fr: 'Dimanche'
      ,pt: 'Domingo'
      ,sv: 'Söndag'
      ,ro: 'Duminica'
      }
    ,'Category' : {
      cs: 'Kategorie'
      ,de: 'Kategorie'
      ,fr: 'Catégorie'
      ,pt: 'Categoria'
      ,sv: 'Kategori'
      ,ro: 'Categorie'
      }
    ,'Subcategory' : {   
      cs: 'Podkategorie'
      ,de: 'Unterkategorie'
      ,fr: 'Sous-catégorie'
      ,pt: 'Subcategoria'
      ,sv: 'Underkategori'
      ,ro: 'Subcategorie'
      }
    ,'Name' : {   
      cs: 'Jméno'
      ,de: 'Name'
      ,fr: 'Nom'
      ,pt: 'Nome'
      ,sv: 'Namn'
      ,ro: 'Nume'
      }
    ,'Today' : {   
      cs: 'Dnes'
      ,de: 'Heute'
      ,fr: 'Aujourd\'hui'
      ,pt: 'Hoje'
      ,sv: 'Idag'
      ,ro: 'Astazi'
      }
    ,'Last 2 days' : {   
      cs: 'Poslední 2 dny'
      ,de: 'letzte 2 Tage'
      ,fr: '2 derniers jours'
      ,pt: 'Últimos 2 dias'
      ,sv: 'Senaste 2 dagarna'
      ,ro: 'Ultimele 2 zile'
      }
    ,'Last 3 days' : {   
      cs: 'Poslední 3 dny'
      ,de: 'letzte 3 Tage'
      ,fr: '3 derniers jours'
      ,pt: 'Últimos 3 dias'
      ,sv: 'Senaste 3 dagarna'
      ,ro: 'Ultimele 3 zile'
      }
    ,'Last week' : {   
      cs: 'Poslední týden'
      ,de: 'letzte Woche'
      ,fr: 'Semaine Dernière'
      ,pt: 'Semana passada'
      ,sv: 'Senaste veckan'
      ,ro: 'Saptamâna trecuta'
      }
    ,'Last 2 weeks' : {   
      cs: 'Poslední 2 týdny'
      ,de: 'letzte 2 Wochen'
      ,fr: '2 dernières semaines'
      ,pt: 'Últimas 2 semanas'
      ,sv: 'Senaste 2 veckorna'
      ,ro: 'Ultimele 2 saptamâni'
      }
    ,'Last month' : {   
      cs: 'Poslední mesíc'
      ,de: 'letzter Monat'
      ,fr: 'Mois dernier'
      ,pt: 'Mês passado'
      ,sv: 'Senaste månaden'
      ,ro: 'Ultima luna'
      }
    ,'Last 3 months' : {   
      cs: 'Poslední 3 mesíce'
      ,de: 'letzte 3 Monate'
      ,fr: '3 derniers mois'
      ,pt: 'Últimos 3 meses'
      ,sv: 'Senaste 3 månaderna'
      ,ro: 'Ultimele 3 luni'
      }
    ,'From' : {   
      cs: 'Od'
      ,de: 'Von'
      ,fr: 'De'
      ,pt: 'De'
      ,sv: 'Från'
      ,ro: 'De la'
      }
    ,'To' : {   
      cs: 'Do'
      ,de: 'Bis'
      ,fr: 'à'
      ,pt: 'Para'
      ,sv: 'Till'
      ,ro: 'La'
      }
    ,'Notes' : {   
      cs: 'Poznámky'
      ,de: 'Notiz'
      ,fr: 'Notes'
      ,pt: 'Notas'
      ,sv: 'Notering'
      ,ro: 'Note'
      }
    ,'Food' : {   
      cs: 'Jídlo'
      ,de: 'Essen'
      ,fr: 'Nourriture'
      ,pt: 'Comida'
      ,sv: 'Föda'
      ,ro: 'Mâncare'
      }
    ,'Insulin' : {   
      cs: 'Inzulín'
      ,de: 'Insulin'
      ,fr: 'Insuline'
      ,pt: 'Insulina'
      ,sv: 'Insulin'
      ,ro: 'Insulina'
      }
    ,'Carbs' : {   
      cs: 'Sacharidy'
      ,de: 'Kohlenhydrate'
      ,fr: 'Glucides'
      ,pt: 'Carboidrato'
      ,sv: 'Kolhydrater'
      ,ro: 'Carbohidra?i'
      }
    ,'Notes contain' : {   
      cs: 'Poznámky obsahují'
      ,de: 'Notizen beinhalten'
      ,fr: 'Notes contiennent'
      ,pt: 'Notas contém'
      ,sv: 'Notering innehåller'
      ,ro: 'Con?inut note'
      }
    ,'Event type contains' : {   
      cs: 'Typ události obsahuje'
      ,de: 'Ereignis-Typ beinhaltet'
      ,fr: 'Type d\'événement contient'
      ,pt: 'Tipo de evento contém'
      ,sv: 'Händelsen innehåller'
      ,ro: 'Con?inut tip de eveniment'
      }
    ,'Target bg range bottom' : {   
      cs: 'Cílová glykémie spodní'
      ,de: 'Untergrenze des Blutzuckerzielbereichs'
      ,fr: 'Limite inférieure glycémie'
      ,pt: 'Limite inferior de glicemia'
      ,sv: 'Gräns för nedre blodsockervärde'
      ,ro: 'Limita de jos a glicemiei'
      }
    ,'top' : {   
      cs: 'horní'
      ,de: 'oben'
      ,fr: 'Supérieur'
      ,pt: 'Superior'
      ,sv: 'Toppen'
      ,ro: 'Sus'
      }
    ,'Show' : {   
      cs: 'Zobraz'
      ,de: 'Zeige'
      ,fr: 'Montrer'
      ,pt: 'Mostrar'
      ,sv: 'Visa'
      ,ro: 'Arata'
      }
    ,'Display' : {   
      cs: 'Zobraz'
      ,de: 'Zeige'
      ,fr: 'Afficher'
      ,pt: 'Mostrar'
      ,sv: 'Visa'
      ,ro: 'Afi?eaza'
      }
    ,'Loading' : {   
      cs: 'Nahrávám'
      ,de: 'Laden'
      ,fr: 'Chargement'
      ,pt: 'Carregando'
      ,sv: 'Laddar'
      ,ro: 'Se încarca'
      }
    ,'Loading profile' : {   
      cs: 'Nahrávám profil'
      ,de: 'Lade Profil'
      ,fr: 'Chargement du profil'
      ,pt: 'Carregando perfil'
      ,sv: 'Laddar profil'
      ,ro: 'Încarc profilul'
      }
    ,'Loading status' : {   
      cs: 'Nahrávám status'
      ,de: 'Lade Status'
      ,fr: 'Statut du chargement'
      ,pt: 'Carregando status'
      ,sv: 'Laddar status'
      ,ro: 'Încarc statusul'
      }
    ,'Loading food database' : {   
      cs: 'Nahrávám databázi jídel'
      ,de: 'Lade Essensdatenbank'
      ,fr: 'Chargement de la base de données alimentaire'
      ,pt: 'Carregando dados de alimentos'
      ,sv: 'Laddar födoämnesdatabas'
      ,ro: 'Încarc baza de date de alimente'
      }
    ,'not displayed' : {   
      cs: 'není zobrazeno'
      ,de: 'nicht angezeigt'
      ,fr: 'non affiché'
      ,pt: 'não mostrado'
      ,sv: 'Visas ej'
      ,ro: 'neafi?at'
      }
    ,'Loading CGM data of' : {   
      cs: 'Nahrávám CGM data'
      ,de: 'Lade CGM-Daten von'
      ,fr: 'Chargement données CGM de'
      ,pt: 'Carregando dados de CGM de'
      ,sv: 'Laddar CGM-data för'
      ,ro: 'Încarc datele CGM ale lui'
      }
    ,'Loading treatments data of' : {   
      cs: 'Nahrávám data ošetrení'
      ,de: 'Lade Behandlungsdaten von'
      ,fr: 'Chargement données traitement de'
      ,pt: 'Carregando dados de tratamento de'
      ,sv: 'Laddar behandlingsdata för'
      ,ro: 'Încarc datele despre tratament pentru'
      }
    ,'Processing data of' : {   
      cs: 'Zpracovávám data'
      ,de: 'Verarbeite Daten von'
      ,fr: 'Traitement des données de'
      ,pt: 'Processando dados de'
      ,sv: 'Behandlar data för'
      ,ro: 'Procesez datele lui'
      }
    ,'Portion' : {   
      cs: 'Porce'
      ,de: 'Portion'
      ,fr: 'Portion'
      ,pt: 'Porção'
      ,sv: 'Portion'
      ,ro: 'Por?ie'
      }
    ,'Size' : {   
      cs: 'Rozmer'
      ,de: 'Größe'
      ,fr: 'Taille'
      ,pt: 'Tamanho'
      ,sv: 'Storlek'
      ,ro: 'Marime'
      }
    ,'(none)' : {   
      cs: '(Prázdný)'
      ,de: '(nichts)'
      ,fr: '(aucun)'
      ,pt: '(nenhum)'
      ,sv: '(ingen)'
      ,ro: '(fara)'
      }
    ,'Result is empty' : {   
      cs: 'Prázdný výsledek'
      ,de: 'Leeres Ergebnis'
      ,fr: 'Pas de résultat' 
      ,pt: 'Resultado vazio'
      ,sv: 'Resulatat saknas'
      ,ro: 'Fara rezultat'
      }
// ported reporting
    ,'Day to day' : {   
      cs: 'Den po dni'
      ,fr: 'jour par jour'
      ,pt: 'Dia a dia'
      ,sv: 'Dag för dag'
      ,ro: 'Zi cu zi'
      }
    ,'Daily Stats' : {   
      cs: 'Denní statistiky'
      ,fr: 'Stats quotidiennes'
      ,pt: 'Estatísticas diárias'
      ,sv: 'Dygnsstatistik'
      ,ro: 'Statistici zilnice'
      }
    ,'Percentile Chart' : {   
      cs: 'Percentil'
      ,fr: 'Percentiles'
      ,pt: 'Percentis'
      ,sv: 'Procentgraf'
      ,ro: 'Grafic percentile'
      }
    ,'Distribution' : {   
      cs: 'Rozložení'
      ,fr: 'Distribution'
      ,pt: 'Distribuição'
      ,sv: 'Distribution'
      ,ro: 'Distribu?ie'
	  }
    ,'Hourly stats' : {   
      cs: 'Statistika po hodinách'
      ,fr: 'Statistiques horaires'
      ,pt: 'Estatísticas por hora'
      ,sv: 'Timmstatistik'
      ,ro: 'Statistici orare'
	  }
    ,'Weekly success' : {   
      cs: 'Statistika po týdnech'
      ,fr: 'Résultat hebdomadaire'
      ,pt: 'Resultados semanais'
      ,sv: 'Veckoresultat'
      ,ro: 'Rezultate saptamânale'
      }
    ,'No data available' : {   
      cs: 'Žádná dostupná data'
      ,fr: 'Pas de données disponibles'
      ,pt: 'não há dados'
      ,sv: 'Data saknas'
      ,ro: 'Fara date'
      }
    ,'Low' : {   
      cs: 'Nízká'
      ,fr: 'Bas'
      ,pt: 'Baixo'
      ,sv: 'Låg'
      ,ro: 'Prea jos'
      }
    ,'In Range' : {   
      cs: 'V rozsahu'
      ,fr: 'dans la norme'
      ,pt: 'Na meta'
      ,sv: 'Inom intervallet'
      ,ro: 'În interval'
      }
    ,'Period' : {   
      cs: 'Období'
      ,fr: 'Période'
      ,pt: 'Período'
      ,sv: 'Period'
      ,ro: 'Perioada'
      }
    ,'High' : {   
      cs: 'Vysoká'
      ,fr: 'Haut'
      ,pt: 'Alto'
      ,sv: 'Hög'
      ,ro: 'Prea sus'
      }
    ,'Average' : {   
      cs: 'Prumerná'
      ,fr: 'Moyenne'
      ,pt: 'Média'
      ,sv: 'Genomsnittligt'
      ,ro: 'Media'
      }
    ,'Low Quartile' : {   
      cs: 'Nízký kvartil'
      ,fr: 'Quartile inférieur'
      ,pt: 'Quartil inferior'
      ,sv: 'Nedre kvadranten'
      ,ro: 'Patrime inferioara'
      }
    ,'Upper Quartile' : {   
      cs: 'Vysoký kvartil'
      ,fr: 'Quartile supérieur'
      ,pt: 'Quartil superior'
      ,sv: 'Övre kvadranten'
      ,ro: 'Patrime superioara'
      }
    ,'Quartile' : {   
      cs: 'Kvartil'
      ,fr: 'Quartile'
      ,pt: 'Quartil'
      ,sv: 'Kvadrant'
      ,ro: 'Patrime'
      }
    ,'Date' : {   
      cs: 'Datum'
      ,fr: 'Date'
      ,pt: 'Data'
      ,sv: 'Datum'
      ,ro: 'Data'
      }
    ,'Normal' : {   
      cs: 'Normální'
      ,fr: 'Normale'
      ,pt: 'Normal'
      ,sv: 'Normal'
      ,ro: 'Normal'
      }
    ,'Median' : {   
      cs: 'Medián'
      ,fr: 'Médiane'
      ,pt: 'Mediana'
      ,sv: 'Median'
      ,ro: 'Mediana'
      }
    ,'Readings' : {   
      cs: 'Záznamu'
      ,fr: 'Valeurs'
      ,pt: 'Valores'
      ,sv: 'Avläsning'
      ,ro: 'Valori'
      }
    ,'StDev' : {   
      cs: 'St. odchylka'
      ,fr: 'Déviation St.'
      ,pt: 'DesvPadr'
      ,sv: 'StdDev'
      ,ro: 'Dev Std'
      }
    ,'Daily stats report' : {   
      cs: 'Denní statistiky'
      ,fr: 'Rapport quotidien'
      ,pt: 'Relatório diário'
      ,sv: 'Dygnsstatistik'
      ,ro: 'Raport statistica zilnica'
      }
    ,'Glucose Percentile report' : {   
      cs: 'Tabulka percentil glykémií'
      ,fr: 'Rapport precentiles Glycémie'
      ,pt: 'Relatório de Percentis de Glicemia'
      ,sv: 'Glukosrapport i procent'
      ,ro: 'Raport percentile glicemii'
      }
    ,'Glucose distribution' : {   
      cs: 'Rozložení glykémií'
      ,fr: 'Distribution glycémies'
      ,pt: 'Distribuição de glicemias'
      ,sv: 'Glukosdistribution'
      ,ro: 'Distribu?ie glicemie'
      }
    ,'days total' : {   
      cs: 'dní celkem'
      ,fr: 'jours totaux'
      ,pt: 'dias total'
      ,sv: 'antal dagar'
      ,ro: 'total zile'
      }
    ,'Overall' : {   
      cs: 'Celkem'
      ,fr: 'Dans l\'ensemble'
      ,pt: 'Geral'
      ,sv: 'Genomsnitt'
      ,ro: 'General'
      }
    ,'Range' : {   
      cs: 'Rozsah'
      ,fr: 'Intervalle'
      ,pt: 'intervalo'
      ,sv: 'Intervall'
      ,ro: 'Interval'
      }
    ,'% of Readings' : {   
      cs: '% záznamu'
      ,pt: '% de valores'
      ,sv: '& av avläsningar'
      ,ro: '% de valori'
      }
    ,'# of Readings' : {   
      cs: 'pocet záznamu'
      ,fr: 'nbr de valeurs'
      ,pt: 'N° de valores'
      ,sv: 'av avläsningar'
      ,ro: 'nr. de valori'
      }
    ,'Mean' : {   
      cs: 'Strední hodnota'
      ,fr: 'Moyenne'
      ,pt: 'Média'
      ,sv: 'Genomsnitt'
      ,ro: 'Medie'
      }
    ,'Standard Deviation' : {   
      cs: 'Standardní odchylka'
      ,fr: 'Déviation Standard'
      ,pt: 'Desvio padrão
      ,sv: 'Standardavvikelse'
      ,ro: 'Devia?ie standard'
      }
    ,'Max' : {   
      cs: 'Max'
      ,fr: 'Max'
      ,pt: 'Max'
      ,sv: 'Max'
      ,ro: 'Max'
      }
    ,'Min' : {   
      cs: 'Min'
      ,fr: 'Min'
      ,pt: 'Min'
      ,sv: 'Min'
      ,ro: 'Min'
      }
    ,'A1c estimation*' : {   
      cs: 'Predpokládané HBA1c*'
      ,fr: 'Estimation HbA1c*'
      ,pt: 'A1c estimada'
      ,sv: 'Beräknat A1c-värde '
      ,ro: 'HbA1C estimata'
      }
    ,'Weekly Success' : {   
      cs: 'Týdenní úspešnost'
      ,fr: 'Réussite hebdomadaire'
      ,pt: 'Resultados semanais'
      ,sv: 'Veckoresultat'
      ,ro: 'Rezultate saptamânale'
      }
    ,'There is not sufficient data to run this report. Select more days.' : {   
      cs: 'Není dostatek dat. Vyberte delší casové období.'
      ,fr: 'Pas assez de données pour un rapport. Sélectionnez plus de jours.'
      ,pt: 'Não há dados suficientes. Selecione mais dias'
      ,sv: 'Data saknas för att köra rapport. Välj fler dagar.'
      ,ro: 'Nu sunt sufieciente date pentru acest raport. Selecta?i mai multe zile.'
	  }
// food editor
    ,'Using stored API secret hash' : {   
      cs: 'Používám uložený hash API hesla'
      ,fr: 'Utilisation du hash API existant'
      ,pt: 'Usando o hash de API existente'
      ,sv: 'Använd hemlig API-nyckel'
      ,ro: 'Utilizez cheie API secreta'
      }
    ,'No API secret hash stored yet. You need to enter API secret.' : {   
      cs: 'Není uložený žádný hash API hesla. Musíte zadat API heslo.'
      ,fr: 'Pas de secret API existant. Vous devez en entrer un.'
      ,pt: 'Hash de segredo de API inexistente. Entre um segredo de API'
      ,sv: 'Hemlig api-nyckel saknas. Du måste ange API hemlighet'
      ,ro: 'Înca nu exista cheie API secreta. Aceasta trebuie introdusa.'
      }
    ,'Database loaded' : {   
      cs: 'Databáze nactena'
      ,fr: 'Base de données chargée'
      ,pt: 'Banco de dados carregado'
      ,sv: 'Databas laddad'
      ,ro: 'Baza de date încarcata'
      }
    ,'Error: Database failed to load' : {   
      cs: 'Chyba pri nacítání databáze'
      ,fr: 'Erreur, le chargement de la base de données a échoué'
      ,pt: 'Erro: Banco de dados não carregado'
      ,sv: 'Error: Databas kan ej laddas'
      ,ro: 'Eroare: Nu s-a încarcat baza de date'
      }
    ,'Create new record' : {   
      cs: 'Vytvorit nový záznam'
      ,fr: 'Créer nouvel enregistrement'
      ,pt: 'Criar novo registro'
      ,sv: 'Skapa ny post'
      ,ro: 'Creaza înregistrare noua'
      }
    ,'Save record' : {   
      cs: 'Uložit záznam'
      ,fr: 'Sauver enregistrement'
      ,pt: 'Salvar registro'
      ,sv: 'Spara post'
      ,ro: 'Salveaza înregistrarea'
      }
    ,'Portions' : {   
      cs: 'Porcí'
      ,fr: 'Portions'
      ,pt: 'Porções'
      ,sv: 'Portion'
      ,ro: 'Por?ii'
      }
    ,'Unit' : {   
      cs: 'Jedn'
      ,fr: 'Unités'
      ,pt: 'Unidade'
      ,sv: 'Enhet'
      ,ro: 'Unita?i'
      }
    ,'GI' : {   
      cs: 'GI'
      ,fr: 'IG'
      ,pt: 'IG'
      ,sv: 'GI'
      ,ro: 'CI'
      }
    ,'Edit record' : {   
      cs: 'Upravit záznam'
      ,fr: 'Modifier enregistrement'
      ,pt: 'Editar registro'
      ,sv: 'Editera post'
      ,ro: 'Editeaza înregistrarea'
      }
    ,'Delete record' : {   
      cs: 'Smazat záznam'
      ,fr: 'Effacer enregistrement'
      ,pt: 'Apagar registro'
      ,sv: 'Ta bort post'
      ,ro: '?terge înregistrarea'
      }
    ,'Move to the top' : {   
      cs: 'Presun na zacátek'
      ,fr: 'Déplacer au sommet'
      ,pt: 'Mover para o topo'
      ,sv: 'Gå till toppen'
      ,ro: 'Mergi la început'
      }
    ,'Hidden' : {   
      cs: 'Skrytý'
      ,fr: 'Caché'
      ,pt: 'Oculto'
      ,sv: 'Dold'
      ,ro: 'Ascuns'
      }
    ,'Hide after use' : {   
      cs: 'Skryj po použití'
      ,fr: 'Cacher après utilisation'
      ,pt: 'Ocultar após uso'
      ,sv: 'Dölj efter användning'
      ,ro: 'Ascunde dupa folosireaa'
      }
    ,'Your API secret must be at least 12 characters long' : {   
      cs: 'Vaše API heslo musí mít alespon 12 znaku'
      ,fr: 'Votre secret API doit contenir au moins 12 caractères'
      ,pt: 'Seu segredo de API deve conter no mínimo 12 caracteres'
      ,sv: 'Hemlig API-nyckel måsta innehålla 12 tecken'
      ,ro: 'Cheia API trebuie sa aiba mai mult de 12 caractere'
      }
    ,'Bad API secret' : {   
      cs: 'Chybné API heslo'
      ,fr: 'Secret API erroné'
      ,pt: 'Segredo de API fraco'
      ,sv: 'Felaktig API-nyckel'
      ,ro: 'Cheie API gre?ita'
      }
    ,'API secret hash stored' : {   
      cs: 'Hash API hesla uložen'
      ,fr: 'Hash API secret sauvegardé'
      ,pt: 'Segredo de API guardado'
      ,sv: 'Hemlig API-hash lagrad'
      ,ro: 'Cheie API înregistrata'
      }
    ,'Status' : {   
      cs: 'Status'
      ,fr: 'Statut'
      ,pt: 'Status'
      ,sv: 'Status'
      ,ro: 'Status'
      }
    ,'Not loaded' : {   
      cs: 'Nenactený'
      ,fr: 'Non chargé'
      ,pt: 'Não carregado'
      ,sv: 'Ej laddad'
      ,ro: 'Neîncarcat'
      }
    ,'Food editor' : {   
      cs: 'Editor jídel'
      ,fr: 'Editeur aliments'
      ,pt: 'Editor de alimentos'
      ,sv: 'Födoämneseditor'
      ,ro: 'Editor alimente'
      }
    ,'Your database' : {   
      cs: 'Vaše databáze'
      ,fr: 'Votre base de données'
      ,pt: 'Seu banco de dados'
      ,sv: 'Din databas'
      ,ro: 'Baza de date'
      }
    ,'Filter' : {   
      cs: 'Filtr'
      ,fr: 'Filtre'
      ,pt: 'Filtro'
      ,sv: 'Filter'
      ,ro: 'Filtru'
      }
    ,'Save' : {   
      cs: 'Ulož'
      ,fr: 'Sauver'
      ,pt: 'Salvar'
      ,sv: 'Spara'
      ,ro: 'Salveaza'
      }
    ,'Clear' : {   
      cs: 'Vymaž'
      ,fr: 'Effacer'
      ,pt: 'Apagar'
      ,sv: 'Rensa'
      ,ro: 'Ini?ializare'
      }
    ,'Record' : {   
      cs: 'Záznam'
      ,fr: 'Enregistrement'
      ,pt: 'Gravar'
      ,sv: 'Post'
      ,ro: 'Înregistrare'
      }
    ,'Quick picks' : {   
      cs: 'Rychlý výber'
      ,fr: 'Sélection rapide'
      ,pt: 'Seleção rápida'
      ,sv: 'Snabbval'
      ,ro: 'Selec?ie rapida'
      }
    ,'Show hidden' : {   
      cs: 'Zobraz skryté'
      ,fr: 'Montrer cachés'
      ,pt: 'Mostrar ocultos'
      ,sv: 'Visa dolda'
      ,ro: 'Arata înregistrarile ascunse'
      }
    ,'Your API secret' : {   
      cs: 'Vaše API heslo'
      ,fr: 'Votre secret API'
      ,pt: 'Seu segredo de API'
      ,sv: 'Din API-nyckel'
      ,ro: 'Cheia API'
      }
    ,'Store hash on this computer (Use only on private computers)' : {   
      cs: 'Ulož hash na tomto pocítaci (používejte pouze na soukromých pocítacích)'
      ,fr: 'Sauver le hash sur cet ordinateur (privé uniquement)'
      ,pt: 'Salvar hash nesse computador (Somente em computadores privados)'
      ,sv: 'Lagra hashvärde på denna dator (använd endast på privat dator)'
      ,ro: 'Salveaza cheia pe acest PC (Folosi?i doar PC de încredere)'
      }
    ,'Treatments' : {   
      cs: 'Ošetrení'
      ,fr: 'Traitements'
      ,pt: 'Tratamentos'
      ,sv: 'Behandling'
      ,ro: 'Tratamente'
      }
    ,'Time' : {   
      cs: 'Cas'
      ,fr: 'Heure'
      ,pt: 'Hora'
      ,sv: 'Tid'
      ,ro: 'Ora'
      }
    ,'Event Type' : {   
      cs: 'Typ události'
      ,fr: 'Type d\'événement'
      ,pt: 'Tipo de evento'
      ,sv: 'Händelsetyp'
      ,ro: 'Tip eveniment'
      }
    ,'Blood Glucose' : {   
      cs: 'Glykémie'
      ,fr: 'Glycémie'
      ,pt: 'Glicemia'
      ,sv: 'Glukosvärde'
      ,ro: 'Glicemie'
      }
    ,'Entered By' : {   
      cs: 'Zadal'
      ,fr: 'Entré par'
      ,pt: 'Inserido por'
      ,sv: 'Inlagt av'
      ,ro: 'Introdus de'
      }
    ,'Delete this treatment?' : {   
      cs: 'Vymazat toto ošetrení?'
      ,fr: 'Effacer ce traitement?'
      ,pt: 'Apagar este tratamento'
      ,sv: 'Ta bort händelse?'
      ,ro: '?terge acest eveniment?'
      }
    ,'Carbs Given' : {   
      cs: 'Sacharidu'
      ,fr: 'Glucides donnés'
      ,pt: 'Carboidratos'
      ,sv: 'Antal kolhydrater'
      ,ro: 'Carbohidra?i'
      }
    ,'Inzulin Given' : {   
      cs: 'Inzulínu'
      ,fr: 'Insuline donnée'
      ,pt: 'Insulina'
      ,sv: 'Insulin'
      ,ro: 'Insulina administrata'
      }
    ,'Event Time' : {   
      cs: 'Cas události'
      ,fr: 'Heure de l\'événement'
      ,pt: 'Hora do evento'
      ,sv: 'Klockslag'
      ,ro: 'Ora evenimentului'
      }
    ,'Please verify that the data entered is correct' : {   
      cs: 'Prosím zkontrolujte, zda jsou údaje zadány správne'
      ,fr: 'Merci de vérifier la correction des données entrées'
      ,pt: 'Favor verificar se os dados estão corretos'
      ,sv: 'Vänligen verifiera att inlagd data stämmer'
      ,ro: 'Verifica?i conexiunea datelor introduse'
      }
    ,'BG' : {   
      cs: 'Glykémie'
      ,fr: 'Glycémie'
      ,pt: 'Glicemia'
      ,sv: 'BS'
      ,ro: 'Glicemie'
      }
    ,'Use BG correction in calculation' : {   
      cs: 'Použij korekci na glykémii'
      ,fr: 'Utiliser la correction de glycémie dans les calculs'
      ,pt: 'Usar correção de glicemia nos cálculos'
      ,sv: 'Använd BS-korrektion för uträkning'
      ,ro: 'Folose?te corec?ia de glicemie în calcule'
      }
    ,'BG from CGM (autoupdated)' : {   
      cs: 'Glykémie z CGM (automaticky aktualizovaná)'
      ,fr: 'Glycémie CGM (automatique)'
      ,pt: 'Glicemia do sensor (Automático)'
      ,sv: 'BS från CGM (automatiskt)'
      ,ro: 'Glicemie în senzor (automat)'
      }
    ,'BG from meter' : {   
      cs: 'Glykémie z glukomeru'
      ,fr: 'Glycémie glucomètre'
      ,pt: 'Glicemia do glicosímetro'
      ,sv: 'BS från blodsockermätare'
      ,ro: 'Glicemie în glucometru'
      }
    ,'Manual BG' : {   
      cs: 'Rucne zadaná glykémie'
      ,fr: 'Glycémie manuelle'
      ,pt: 'Glicemia Manual'
      ,sv: 'Manuellt BS'
      ,ro: 'Glicemie manuala'
      }
    ,'Quickpick' : {   
      cs: 'Rychlý výber'
      ,fr: 'Sélection rapide'
      ,pt: 'Seleção rápida'
      ,sv: 'Snabbval'
      ,ro: 'Selec?ie rapida'
      }
    ,'or' : {   
      cs: 'nebo'
      ,fr: 'ou'
      ,pt: 'or'
      ,sv: 'Eller'
      ,ro: 'sau'
      }
    ,'Add from database' : {   
      cs: 'Pridat z databáze'
      ,fr: 'Ajouter à partir de la base de données'
      ,pt: 'Adicionar do banco de dados'
      ,sv: 'Lägg till från databas'
      ,ro: 'Adauga din baza de date'
      }
    ,'Use carbs correction in calculation' : {   
      cs: 'Použij korekci na sacharidy'
      ,fr: 'Utiliser la correction en glucides dans les calculs'
      ,pt: 'Usar correção com carboidratos no cálculo'
      ,sv: 'Använd kolhydratkorrektion i utäkning'
      ,ro: 'Folose?te corec?ia de carbohidra?i în calcule'
      }
    ,'Use COB correction in calculation' : {   
      cs: 'Použij korekci na COB'
      ,fr: 'Utiliser les COB dans les calculs'
      ,pt: 'Usar COB no cálculo'
      ,sv: 'Använd aktiva kolhydrater för beräkning'
      ,ro: 'Folose?te COB în calcule'
      }
    ,'Use IOB in calculation' : {   
      cs: 'Použij IOB ve výpoctu'
      ,fr: 'Utiliser l\'IOB dans les calculs'
      ,pt: 'Usar IOB no cálculo'
      ,sv: 'Använd aktivt insulin för uträkning'
      ,ro: 'Folose?te IOB în calcule'
      }
    ,'Other correction' : {   
      cs: 'Jiná korekce'
      ,fr: 'Autre correction'
      ,pt: 'Outra correção'
      ,sv: 'Övrig korrektion'
      ,ro: 'Alte corec?ii'
      }
    ,'Rounding' : {   
      cs: 'Zaokrouhlení'
      ,fr: 'Arrondi'
      ,pt: 'Arredondamento'
      ,sv: 'Avrundning'
      ,ro: 'Rotunjire'
	  }
    ,'Enter insulin correction in treatment' : {   
      cs: 'Zahrn inzulín do záznamu ošetrení'
      ,fr: 'Entrer correction insuline dans le traitement'
      ,pt: 'Inserir correção de insulina no tratamento'
      ,sv: 'Ange insulinkorrektion för händelse'
      ,ro: 'Introdu corec?ia de insulina în tratament'
      }
    ,'Insulin needed' : {   
      cs: 'Potrebný inzulín'
      ,fr: 'Insuline nécessaire'
      ,pt: 'Insulina necessária'
      ,sv: 'Beräknad insulinmängd'
      ,ro: 'Necesar insulina' 
      }
    ,'Carbs needed' : {   
      cs: 'Potrebné sach'
      ,fr: 'Glucides nécessaires'
      ,pt: 'Carboidratos necessários'
      ,sv: 'Beräknad kolhydratmängd'
      ,ro: 'Necesar carbohidra?i'
      }
    ,'Carbs needed if Insulin total is negative value' : {   
      cs: 'Chybející sacharidy v prípade, že výsledek je záporný'
      ,fr: 'Glucides nécessaires si insuline totale négative'
      ,pt: 'Carboidratos necessários se Insulina total for negativa'
      ,sv: 'Nödvändig kolhydratmängd för angiven insulinmängd'
      ,ro: 'Carbohidra?i când necesarul de insulina este negativ'
      }
    ,'Basal rate' : {   
      cs: 'Bazál'
      ,fr: 'Taux basal'
      ,pt: 'Taxa basal'
      ,sv: 'Basaldos'
      ,ro: 'Rata bazala'
      }
    ,'60 minutes earlier' : {   
      cs: '60 min predem'
      ,fr: '60 min avant'
      ,pt: '60 min antes'
      ,sv: '60 min tidigare'
      ,ro: 'acum 60 min'
      }
    ,'45 minutes earlier' : {   
      cs: '45 min predem'
      ,fr: '45 min avant'
      ,pt: '45 min antes'
      ,sv: '45 min tidigare'
      ,ro: 'acum 45 min'
      }
    ,'30 minutes earlier' : {   
      cs: '30 min predem'
      ,fr: '30 min avant'
      ,pt: '30 min antes'
      ,sv: '30 min tidigare'
      ,ro: 'acum 30 min'
      }
    ,'20 minutes earlier' : {   
      cs: '20 min predem'
      ,fr: '20 min avant'
      ,pt: '20 min antes'
      ,sv: '20 min tidigare'
      ,ro: 'acum 20 min'
      }
    ,'15 minutes earlier' : {   
      cs: '15 min predem'
      ,fr: '15 min avant'
      ,pt: '15 min antes'
      ,sv: '15 min tidigare'
      ,ro: 'acu 15 min'
      }
    ,'Time in minutes' : {   
      cs: 'Cas v minutách'
      ,fr: 'Durée en minutes'
      ,pt: 'Tempo em minutos'
      ,sv: 'Tid i minuter'
      ,ro: 'Timp în minute'
      }
    ,'15 minutes later' : {   
      cs: '15 min po'
      ,fr: '15 min après'
	  ,pt: '15 min depois'
      ,sv: '15 min senare'
      ,ro: 'dupa 15 min'
	  
      }
    ,'20 minutes later' : {   
      cs: '20 min po'
      ,fr: '20 min après'
      ,pt: '20 min depois'
      ,sv: '20 min senare'
      ,ro: 'dupa 20 min'
      }
    ,'30 minutes later' : {   
      cs: '30 min po'
      ,fr: '30 min après'
      ,pt: '30 min depois'
      ,sv: '30 min senare'
      ,ro: 'dupa 30 min'
      }
    ,'45 minutes later' : {   
      cs: '45 min po'
      ,fr: '45 min après'
      ,pt: '45 min depois'
      ,sv: '45 min senare'
      ,ro: 'dupa 45 min'
      }
    ,'60 minutes later' : {   
      cs: '60 min po'
      ,fr: '60 min après'
      ,pt: '60 min depois'
      ,sv: '60 min senare'
      ,ro: 'dupa 60 min'
      }
    ,'Additional Notes, Comments' : {   
      cs: 'Dalši poznámky, komentáre'
      ,fr: 'Notes additionnelles, commentaires'
      ,pt: 'Notas adicionais e comentários'
      ,sv: 'Notering, övrigt'
      ,ro: 'Note adi?ionale, comentarii'
      }
    ,'RETRO MODE' : {   
      cs: 'V MINULOSTI'
      ,fr: 'MODE RETROSPECTIF'
      ,pt: 'Modo Retrospectivo'
      ,sv: 'Retroläge'
      ,ro: 'MOD RETROSPECTIV'
      }
    ,'Now' : {   
      cs: 'Nyní'
      ,fr: 'Maintenant'
      ,pt: 'Agora'
      ,sv: 'Nu'
      ,ro: 'Acum'
      }
    ,'Other' : {   
      cs: 'Jiný'
      ,fr: 'Autre'
      ,pt: 'Outro'
      ,sv: 'Övrigt'
      ,ro: 'Altul'
      }
    ,'Submit Form' : {   
      cs: 'Odeslat formulár'
      ,fr: 'Formulaire de soumission'
      ,pt: 'Submeter formulário'
      ,sv: 'Överför händelse'
      ,ro: 'Trimite formularul'
      }
    ,'Profile editor' : {   
      cs: 'Editor profilu'
      ,fr: 'Editeur de profil'
      ,pt: 'Editor de perfil'
      ,sv: 'Editera profil'
      ,ro: 'Editare profil'
      }
    ,'Reporting tool' : {   
      cs: 'Výkazy'
      ,fr: 'Outil de rapport'
      ,pt: 'Ferramenta de relatórios'
      ,sv: 'Rapportverktyg'
      ,ro: 'Instrument de rapoarte'
      }
    ,'Add food from your database' : {   
      cs: 'Pridat jidlo z Vaší databáze'
      ,fr: 'Ajouter aliment de votre base de données'
      ,pt: 'Incluir alimento do seu banco de dados'
      ,sv: 'Lägg till livsmedel från databas'
      ,ro: 'Adauga alimente din baza de date'
      }
    ,'Reload database' : {   
      cs: 'Znovu nahraj databázi'
      ,fr: 'Recharger la base de données'
      ,pt: 'Recarregar banco de dados'
      ,sv: 'Ladda om databas'
      ,ro: 'Reîncarca baza de date'
      }
    ,'Add' : {   
      cs: 'Pridej'
      ,fr: 'Ajouter'
      ,pt: 'Adicionar'
      ,sv: 'Lägg till'
      ,ro: 'Adauga'
      }
    ,'Unauthorized' : {   
      cs: 'Neautorizováno'
      ,fr: 'Non autorisé'
      ,pt: 'Não autorizado'
      ,sv: 'Ej behörig'
      ,ro: 'Neautorizat'
      }
    ,'Entering record failed' : {   
      cs: 'Vložení záznamu selhalo'
      ,fr: 'Entrée enregistrement a échoué'
      ,pt: 'Entrada de registro falhou'
      ,sv: 'Lägga till post nekas'
      ,ro: 'Înregistrare e?uata'
      }
    ,'Device authenticated' : {   
      cs: 'Zarízení overeno'
      ,fr: 'Appareil authentifié'
      ,pt: 'Dispositivo autenticado'
      ,sv: 'Enhet autentiserad'
      ,ro: 'Dispozitiv autentificat'
      }
    ,'Device not authenticated' : {   
      cs: 'Zarízení není overeno'
      ,fr: 'Appareil non authentifié'
      ,pt: 'Dispositivo não autenticado'
      ,sv: 'Enhet EJ autentiserad'
      ,ro: 'Dispozitiv neautentificat'
      }
    ,'Authentication status' : {   
      cs: 'Stav overení'
      ,fr: 'Status de l\'authentification'
      ,pt: 'Status de autenticação'
      ,sv: 'Autentiseringsstatus'
      ,ro: 'Starea autentificarii'
      }
    ,'Authenticate' : {   
      cs: 'Overit'
      ,fr: 'Authentifier'
      ,pt: 'Autenticar'
      ,sv: 'Autentiserar'
      ,ro: 'Autentificare'
      }
    ,'Remove' : {   
      cs: 'Vymazat'
      ,fr: 'Retirer'
      ,pt: 'Remover'
      ,sv: 'Ta bort'
      ,ro: '?terge'
      }
    ,'Your device is not authenticated yet' : {   
      cs: 'Toto zarízení nebylo dosud overeno'
      ,fr: 'Votre appareil n\'est pas encore authentifié'
      ,pt: 'Seu dispositivo ainda não foi autenticado'
      ,sv: 'Din enhet är ej autentiserad'
      ,ro: 'Dispozitivul nu este autentificat înca'
      }
    ,'Sensor' : {   
      cs: 'Senzor'
      ,fr: 'Senseur'
      ,pt: 'Sensor'
      ,sv: 'Sensor'
      ,ro: 'Senzor'
      }
    ,'Finger' : {   
      cs: 'Glukomer'
      ,fr: 'Doigt'
      ,pt: 'Dedo'
      ,sv: 'Finger'
      ,ro: 'Deget'
      }
    ,'Manual' : {   
      cs: 'Rucne'
      ,fr: 'Manuel'
      ,pt: 'Manual'
      ,sv: 'Manuell'
      ,ro: 'Manual'
      }
    ,'Scale' : {   
      cs: 'Merítko'
      ,fr: 'Echelle'
      ,pt: 'Escala'
      ,sv: 'Skala'
      ,ro: 'Scala'
      }
    ,'Linear' : {   
      cs: 'lineární'
      ,fr: 'Linéaire'
      ,pt: 'Linear'
      ,sv: 'Linjär'
      ,ro: 'Liniar'
      }
    ,'Logarithmic' : {   
      cs: 'logaritmické'
      ,fr: 'Logarithmique'
      ,pt: 'Logarítmica'
      ,sv: 'Logaritmisk'
      ,ro: 'Logaritmic'
      }
    ,'Silence for 30 minutes' : {   
      cs: 'Ztlumit na 30 minut'
      ,fr: 'Silence pendant 30 minutes'
      ,pt: 'Silenciar por 30 minutos'
      ,sv: 'Tyst i 30 min'
      ,ro: 'Ignora pentru 30 minute'
      }
    ,'Silence for 60 minutes' : {   
      cs: 'Ztlumit na 60 minut'
      ,fr: 'Silence pendant 60 minutes'
      ,pt: 'Silenciar por 60 minutos'
      ,sv: 'Tyst i 60 min'
      ,ro: 'Ignora pentru 60 minute'
      }
    ,'Silence for 90 minutes' : {   
      cs: 'Ztlumit na 90 minut'
      ,fr: 'Silence pendant 90 minutes'
      ,pt: 'Silenciar por 90 minutos'
      ,sv: 'Tyst i 90 min'
      ,ro: 'Ignora pentru 90 minure'
      }
    ,'Silence for 120 minutes' : {   
      cs: 'Ztlumit na 120 minut'
      ,fr: 'Silence pendant 120 minutes'
      ,pt: 'Silenciar por 120 minutos'
      ,sv: 'Tyst i 120 min'
      ,ro: 'Ignora pentru 120 minute'
      }
    ,'3HR' : {   
      cs: '3hod'
      ,fr: '3hr'
      ,pt: '3h'
      ,sv: '3tim'
      ,ro: '3h'
      }
    ,'6HR' : {   
      cs: '6hod'
      ,fr: '6hr'
      ,pt: '6h'
      ,sv: '6tim'
      ,ro: '6h'
      }
    ,'12HR' : {   
      cs: '12hod'
      ,fr: '12hr'
      ,pt: '12h'
      ,sv: '12tim'
      ,ro: '12h'
      }
    ,'24HR' : {   
      cs: '24hod'
      ,fr: '24hr'
      ,pt: '24h'
      ,sv: '24tim'
      ,ro: '24h'
      }
    ,'Settings' : {   
      cs: 'Nastavení'
      ,fr: 'Paramètres'
      ,pt: 'Definições'
      ,sv: 'Inställningar'
      ,ro: 'Setari'
      }
    ,'Units' : {   
      cs: 'Jednotky'
      ,fr: 'Unités'
      ,pr: 'Unidades'
      ,sv: 'Enheter'
      ,ro: 'Unita?i'
      }
    ,'Date format' : {   
      cs: 'Formát datumu'
      ,fr: 'Format Date'
      ,pt: 'Formato de data'
      ,sv: 'Datumformat'
      ,ro: 'Formatul datei'
      }
    ,'12 hours' : {   
      cs: '12 hodin'
      ,fr: '12hr'
      ,pt: '12 horas'
      ,sv: '12-timmars'
      ,ro: '12 ore'
      }
    ,'24 hours' : {   
      cs: '24 hodin'
      ,fr: '24hr'
      ,pt: '24 horas'
      ,sv: '24-timmars'
      ,ro: '24 ore'
      }
    ,'Log a Treatment' : {   
      cs: 'Záznam ošetrení'
      ,fr: 'Entrer un traitement'
      ,pr: 'Entre um tratamento'
      ,sv: 'Ange händelse'
      ,ro: 'Înregistreaza un eveniment'
      }
    ,'BG Check' : {   
      cs: 'Kontrola glykémie'
      ,fr: 'Contrôle glycémie'
      ,pt: 'Medida de glicemia'
      ,sv: 'BS-kontroll
      ,ro: 'Verificare glicemie'
      }
    ,'Meal Bolus' : {   
      cs: 'Bolus na jídlo'
      ,fr: 'Bolus repas'
      ,pt: 'Bolus de refeição'
      ,sv: 'Måltidsbolus'
      ,ro: 'Bolus masa'
      }
    ,'Snack Bolus' : {   
      cs: 'Bolus na svacinu'
      ,fr: 'Bolus friandise'
      ,pt: 'Bolus de lanche'
      ,sv: 'Mellanmålsbolus'
      ,ro: 'Bolus gustare'
      }
    ,'Correction Bolus' : {   
      cs: 'Bolus na glykémii'
      ,fr: 'Bolus de correction'
      ,pt: 'Bolus de correção'
      ,sv: 'Korrektionsbolus'
      ,ro: 'Bolus corec?ie'
      }
    ,'Carb Correction' : {   
      cs: 'ptídavek sacharidu'
      ,fr: 'Correction glucide'
      ,pt: 'Carboidrato de correção'
      ,sv: 'Kolhydratskorrektion'
      ,ro: 'Corec?ie de carbohidra?i'
      }
    ,'Note' : {   
      cs: 'Poznámka'
      ,fr: 'Note'
      ,pt: 'Nota'
      ,sv: 'Notering'
      ,ro: 'Nota'
      }
    ,'Question' : {   
      cs: 'Otázka'
      ,fr: 'Question'
      ,pt: 'Pergunta'
      ,sv: 'Fråga'
      ,ro: 'Întrebare'
      }
    ,'Exercise' : {   
      cs: 'Cvicení'
      ,fr: 'Exercice'
      ,pt: 'Exercício'
      ,sv: 'Aktivitet'
      ,ro: 'Activitate fizica'
      }
    ,'Pump Site Change' : {   
      cs: 'Prepíchnutí kanyly'
      ,fr: 'Changement de site pompe'
      ,pt: 'Troca de catéter'
      ,sv: 'Pump/nålbyte'
      ,ro: 'Schimbare loc pompa'
      }
    ,'Sensor Start' : {   
      cs: 'Spuštení sensoru'
      ,fr: 'Démarrage senseur'
      ,pt: 'Início de sensor'
      ,sv: 'Sensorstart'
      ,ro: 'Start senzor'
      }
    ,'Sensor Change' : {   
      cs: 'Výmena sensoru'
      ,fr: 'Changement senseur'
      ,pt: 'Troca de sensor'
      ,sv: 'Sensorbyte'
      ,ro: 'Schimbare senzor'
      }
    ,'Dexcom Sensor Start' : {   
      cs: 'Spuštení sensoru'
      ,fr: 'Démarrage senseur Dexcom'
      ,pt: 'Início de sensor Dexcom'
      ,sv: 'Dexcom sensorstart'
      ,ro: 'Pornire senzor Dexcom'
      }
    ,'Dexcom Sensor Change' : {   
      cs: 'Výmena sensoru'
      ,fr: 'Changement senseur Dexcom'
      ,pt: 'Troca de sensor Dexcom'
      ,sv: 'Dexcom sensorbyte'
      ,ro: 'Schimbare senzor Dexcom'
      }
    ,'Insulin Cartridge Change' : {   
      cs: 'Výmena inzulínu'
      ,fr: 'Changement cartouche d\'insuline'
      ,pt: 'Troca de reservatório de insulina'
      ,sv: 'Insulinreservoarbyte'
      ,ro: 'Schimbare cartu? insulina'
      }
    ,'D.A.D. Alert' : {   
      cs: 'D.A.D. Alert'
      ,fr: 'Wouf! Wouf! Chien d\'alerte diabète'
      ,pt: 'Alerta de cão sentinela de diabetes'
      ,sv: 'Voff voff! (Diabeteshundalarm!)'
      ,ro: 'Alerta câine de serviciu'
      }
    ,'Glucose Reading' : {   
      cs: 'Hodnota glykémie'
      ,fr: 'Valeur de glycémie'
      ,pt: 'Valor de glicemia'
      ,sv: 'Blodglukosavläsning'
      ,ro: 'Valoare glicemie'
      }
    ,'Measurement Method' : {   
      cs: 'Metoda merení'
      ,fr: 'Méthode de mesure'
      ,pt: 'Método de medida'
      ,sv: 'Mätmetod'
      ,ro: 'Metoda masurare'
      }
    ,'Meter' : {   
      cs: 'Glukomer'
      ,fr: 'Glucomètre'
      ,pt: 'Glicosímetro'
      ,sv: 'Mätare'
      ,ro: 'Glucometru'
      }
    ,'Insulin Given' : {   
      cs: 'Inzulín'
      ,fr: 'Insuline donnée'
      ,pt: 'Insulina'
      ,sv: 'Insulindos'
      ,ro: 'Insulina administrata'
      }
    ,'Amount in grams' : {   
      cs: 'Množství v gramech'
      ,fr: 'Quantité en grammes'
      ,pt: 'Quantidade em gramas'
      ,sv: 'Antal gram'
      ,ro: 'Cantitate în grame'
      }
    ,'Amount in units' : {   
      cs: 'Množství v jednotkách'
      ,fr: 'Quantité en unités'
      ,pt: 'Quantidade em unidades'
      ,sv: 'Antal enheter'
      ,ro: 'Cantitate în unita?i'
      }
    ,'View all treatments' : {   
      cs: 'Zobraz všechny ošetrení'
      ,fr: 'Voir tous les traitements'
      ,pt: 'Visualizar todos os tratamentos'
      ,sv: 'Visa behandlingar'
      ,ro: 'Vezi toate evenimentele'
      }
    ,'Enable Alarms' : {   
      cs: 'Povolit alarmy'
      ,fr: 'Activer les alarmes'
      ,pt: 'Ativar alarmes'
      ,sv: 'Slå på alarm'
      ,ro: 'Activeaza alarmele'
      }
    ,'When enabled an alarm may sound.' : {   
      cs: 'Pri povoleném alarmu zní zvuk'
      ,fr: 'Si activée, un alarme peut sonner.'
      ,pt: 'Quando ativado, um alarme poderá soar'
      ,sv: 'När aktiverat ljuder ett alarm'
      ,ro: 'Când este activ, poate suna o alarma.'
      }
    ,'Urgent High Alarm' : {   
      cs: 'Urgentní vysoká glykémie'
      ,fr: 'Alarme haute urgente'
      ,pt: 'Alarme de alto urgente'
      ,sv: 'Brådskande höglarm'
      ,ro: 'Alarma urgenta hiper'
      }
    ,'High Alarm' : {   
      cs: 'Vysoká glykémie'
      ,fr: 'Alarme haute'
      ,pt: 'Alarme de alto'
      ,sv: 'Höglarm'
      ,ro:  'Alarma hiper'
      }
    ,'Low Alarm' : {   
      cs: 'Nízká glykémie'
      ,fr: 'Alarme basse'
      ,pt: 'Alarme de baixo'
      ,sv: 'Låglarm'
      ,ro: 'Alarma hipo'
      }
    ,'Urgent Low Alarm' : {   
      cs: 'Urgentní nízká glykémie'
      ,fr: 'Alarme basse urgente'
      ,pt: 'Alarme de baixo urgente'
      ,sv: 'Brådskande låglarm'
      ,ro: 'Alarma urgenta hipo'
      }
    ,'Stale Data: Warn' : {   
      cs: 'Zastaralá data'
      ,fr: 'Données dépassées'
      ,pt: 'Dados antigos: aviso'
      ,sv: 'Varning: Inaktuell data'
      ,ro: 'Date învechite: alerta'
      }
    ,'Stale Data: Urgent' : {   
      cs: 'Zastaralá data urgentní'
      ,fr: 'Données dépassées urgentes'
      ,pt: 'Dados antigos: Urgente'
      ,sv: 'Brådskande varning, Inaktuell data'
      ,ro: 'Date învechite: urgent'
      }
    ,'mins' : {   
      cs: 'min'
      ,fr: 'mins'
      ,pt: 'min'
      ,sv: 'min'
      ,ro: 'min'
      }
    ,'Night Mode' : {   
      cs: 'Nocní mód'
      ,fr: 'Mode nocturne'
      ,pt: 'Modo noturno'
      ,sv: 'Nattläge'
      ,ro: 'Mod nocturn'
      }
    ,'When enabled the page will be dimmed from 10pm - 6am.' : {   
      cs: 'Když je povoleno, obrazovka je ztlumena 22:00 - 6:00'
      ,fr: 'Si activé, la page sera assombire de 22:00 à 6:00'
      ,pt: 'Se ativado, a página será escurecida de 22h a 6h'
      ,sv: 'När vald dimmas sidan i tio minuter'
      ,ro: 'La activare va scadea iluminarea între 22 ?i 6'
      }
    ,'Enable' : {   
      cs: 'Povoleno'
      ,fr: 'activer'
      ,pt: 'Ativar'
      ,sv: 'Aktivera'
      ,ro: 'Activeaza'
      }
    ,'Settings' : {   
      cs: 'Nastavení'
      ,fr: 'Paramètres'
      ,pt: 'Definições'
      ,sv: 'Inställningar'
      ,ro: 'Setari'
      }
    ,'Show Raw BG Data' : {   
      cs: 'Zobraz RAW data'
      ,fr: 'Montrer les données BG brutes'
      ,pt: 'Mostrar dados de glicemia não processados'
      ,sv: 'Visa RAW-data'
      ,ro: 'Afi?eaza date primare glicemie'
      }
    ,'Never' : {   
      cs: 'Nikdy'
      ,fr: 'Jamais'
      ,pt: 'Nunca'
      ,sv: 'Aldrig'
      ,ro: 'Niciodata'
      }
    ,'Always' : {   
      cs: 'Vždy'
      ,fr: 'Toujours'
      ,pt: 'Sempre'
      ,sv: 'Alltid'
      ,ro: 'Întotdeauna'
      }
    ,'When there is noise' : {   
      cs: 'Pri šumu'
      ,fr: 'Quand il y a du bruit'
      ,pt: 'Quando houver ruído'
      ,sv: 'Endast vid brus'
      ,ro: 'Atunci când este diferen?a'
      }
    ,'When enabled small white dots will be disaplyed for raw BG data' : {   
      cs: 'Když je povoleno, malé tecky budou zobrazeny pro RAW data'
      ,fr: 'Si activé, des points blancs représenteront les données brutes'
      ,pt: 'Se ativado, pontinhos brancos representarão os dados de glicemia não processados'
      ,sv: 'När aktverat visas vita prickar vid brus'
      ,ro: 'La activare vor aparea puncte albe reprezentând citirea bruta a glicemiei'
      }
    ,'Custom Title' : {   
      cs: 'Vlastní název stránky'
      ,fr: 'Titre sur mesure'
      ,pt: 'Customizar Título'
      ,sv: 'Egen titel'
      ,ro: 'Titlu particularizat'
      }
    ,'Theme' : {   
      cs: 'Téma'
      ,fr: 'Thème'
      ,pt: 'tema'
      ,sv: 'Tema'
      ,ro: 'Tema'
      }
    ,'Default' : {   
      cs: 'Výchozí'
      ,fr: 'Par défaut'
      ,pt: 'Padrão'
      ,sv: 'Standard'
      ,ro: 'Implicita'
      }
    ,'Colors' : {   
      cs: 'Barevné'
      ,fr: 'Couleurs'
      ,pt: 'Cores'
      ,sv: 'Färger'
      ,ro: 'Colorata'
      }
    ,'Reset, and use defaults' : {   
      cs: 'Vymaž a nastav výchozí hodnoty'
      ,fr: 'Remise à zéro et utilisation des valeurs par défaut'
      ,pt: 'Zerar e usar padrões'
      ,sv: 'Återställ standardvärden'
      ,ro: 'Reseteaza ?i folose?te setarile implicite'
      }
    ,'Calibrations' : {   
      cs: 'Kalibrace'
      ,fr: 'Calibration'
      ,pt: 'Calibraçôes'
      ,sv: 'Kalibreringar'
      ,ro: 'Calibrari'
      }
    ,'Alarm Test / Smartphone Enable' : {   
      cs: 'Test alarmu'
      ,fr: 'Test alarme'
      ,pt: 'Testar Alarme / Ativar Smartphone'
      ,sv: 'Testa alarm / Aktivera smartphone'
      ,ro: 'Teste alarme / Activeaza pe smartphone'
      }
    ,'Bolus Wizard' : {   
      cs: 'Bolusový kalkulátor'
      ,fr: 'Calculateur de bolus'
      ,pt: 'Bolus Wizard'
      ,sv: 'Boluskalkylator'
      ,ro: 'Calculator sugestie bolus'
      }
    ,'in the future' : {   
      cs: 'v budoucnosti'
      ,fr: 'dans le futur'
      ,pt: 'no futuro'
      ,sv: 'framtida'
      ,ro: 'în viitor'
      }
    ,'time ago' : {   
      cs: 'min zpet'
      ,fr: 'temps avant'
      ,pt: 'tempo atrás'
      ,sv: 'tid sedan'
      ,ro: 'în trecut'
      }
    ,'hr ago' : {   
      cs: 'hod zpet'
      ,fr: 'hr avant'
      ,pt: 'h atrás'
      ,sv: 'timme sedan'
      ,ro: 'ora în trecut'
      }
    ,'hrs ago' : {   
      cs: 'hod zpet'
      ,fr: 'hrs avant'
      ,pt: 'h atrás'
      ,sv: 'Timmar sedan'
      ,ro: 'h în trecut'
      }
    ,'min ago' : {   
      cs: 'min zpet'
      ,fr: 'min avant'
      ,pt: 'min atrás'
      ,sv: 'minut sedan'
      ,ro: 'minut în trecut'
      }
    ,'mins ago' : {   
      cs: 'min zpet'
      ,fr: 'mins avant'
      ,pt: 'min atrás'
      ,sv: 'minuter sedan'
      ,ro: 'minute în trecut'
      }
    ,'day ago' : {   
      cs: 'den zpet'
      ,fr: 'jour avant'
      ,pt: 'dia atrás'
      ,sv: 'dag sedan'
      ,ro: 'zi în trecut'
      }
    ,'days ago' : {   
      cs: 'dnu zpet'
      ,fr: 'jours avant'
      ,pt: 'dias atrás'
      ,sv: 'dagar sedan'
      ,ro: 'zile în trecut'
      }
    ,'long ago' : {   
      cs: 'dlouho zpet'
      ,fr: 'il y a très longtemps...'
      ,pt: 'muito tempo atrás'
      ,sv: 'länge sedan'
      ,ro: 'timp în trecut'
      }
    ,'Clean' : {   
      cs: 'Cistý'
      ,fr: 'Propre'
      ,pt: 'Limpo'
      ,sv: 'Rent'
      ,ro: 'Curat'
      }
    ,'Light' : {   
      cs: 'Lehký'
      ,fr: 'Léger'
      ,pt: 'Leve'
      ,sv: 'Lätt'
      ,ro: 'U?or'
      }
    ,'Medium' : {   
      cs: 'Strední'
      ,fr: 'Moyen'
      ,pt: 'Médio'
      ,sv: 'Måttligt'
      ,ro: 'Mediu'
      }
    ,'Heavy' : {   
      cs: 'Velký'
      ,fr: 'Important'
      ,pt: 'Pesado'
      ,sv: 'Rikligt'
      ,ro: 'Puternic'
      }
    ,'Treatment type' : {   
      cs: 'Typ ošetrení'
      ,fr: 'Type de traitement'
      ,pt: 'Tipo de tratamento'
      ,sv: 'Behandlingstyp'
      ,ro: 'Tip tratament'
      }
    ,'Raw BG' : {   
      cs: 'Glykémie z RAW dat'
      ,fr: 'BG brut'
      ,pt: 'Glicemia sem processamento'
      ,sv: 'RAW-BS'
      ,ro: 'Citire bruta a glicemiei'
      }
    ,'Device' : {   
      cs: 'Zarízení'
      ,fr: 'Appareil'
      ,pt: 'Dispositivo'
      ,sv: 'Device'
      ,ro: 'Dispozitiv'
      }
    ,'Noise' : {   
      cs: 'Šum'
      ,fr: 'Bruit'
      ,pt: 'Ruído'
      ,sv: 'Brus'
      ,ro: 'Zgomot'
      }
    ,'Calibration' : {   
      cs: 'Kalibrace'
      ,fr: 'Calibration'
      ,pt: 'Calibração'
      ,sv: 'Kalibrering'
      ,ro: 'Calibrare'
      }
    ,'Show Plugins' : {   
      cs: 'Zobrazuj pluginy'
      ,pt: 'Mostrar Plugins'
      ,sv: 'Visa tillägg'
      ,ro: 'Arata plugin-urile'
      }
    ,'About' : {   
      cs: 'O aplikaci'
      ,pt: 'Sobre'
      ,sv: 'Om'
      ,ro: 'Despre'
      }
    ,'Value in' : {   
      cs: 'Hodnota v'
      ,pt: 'Valor em'
      ,sv: 'Värde om'
      ,ro: 'Valoare în'
      }
    ,'Carb Time' : {   
      cs: 'Cas jídla'
      ,sv: 'Kolhydratstid'
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
