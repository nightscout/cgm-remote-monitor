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
      ,ro: 'Activ pe portul'
      }
    // Client
    ,'Mo' : {
      cs: 'Po'
      ,de: 'Mo'
      ,fr: 'Lu'
      ,pt: 'Seg'
      ,ro: 'Lu'
      }
    ,'Tu' : {
      cs: 'Út'
      ,de: 'Di'
      ,fr: 'Ma'
      ,pt: 'Ter'
      ,ro: 'Ma'
      },
    ',We' : {
      cs: 'St'
      ,de: 'Mi'
      ,fr: 'Me'
      ,pt: 'Qua'
      ,ro: 'Mie'
      }
    ,'Th' : {
      cs: 'Čt'
      ,de: 'Do'
      ,fr: 'Je'
      ,pt: 'Qui'
      ,ro: 'Jo'
      }
    ,'Fr' : {
      cs: 'Pá'
      ,de: 'Fr'
      ,fr: 'Ve'
      ,pt: 'Sex'
      ,ro: 'Vi'
      }
    ,'Sa' : {
      cs: 'So'
      ,de: 'Sa'
      ,fr: 'Sa'
      ,pt: 'Sa'
      ,ro: 'Sa'
      }
    ,'Su' : {
      cs: 'Ne'
      ,de: 'So'
      ,fr: 'Di'
      ,pt: 'Dom'
      ,ro: 'Du'
      }
    ,'Monday' : {
      cs: 'Pondělí'
      ,de: 'Montag'
      ,fr: 'Lundi'
      ,pt: 'Segunda'
      ,ro: 'Luni'
      }
    ,'Tuesday' : {
      cs: 'Úterý'
      ,de: 'Dienstag'
      ,fr: 'Mardi'
      ,pt: 'Terça'
      ,ro: 'Marți'
      }
    ,'Wednesday' : {
      cs: 'Středa'
      ,de: 'Mittwoch'
      ,fr: 'Mercredi'
      ,pt: 'Quarta'
      ,ro: 'Miercuri'
      }
    ,'Thursday' : {
      cs: 'Čtvrtek'
      ,de: 'Donnerstag'
      ,fr: 'Jeudi'
      ,pt: 'Quinta'
      ,ro: 'Joi'
      }
    ,'Friday' : {
      cs: 'Pátek'
      ,de: 'Freitag'
      ,fr: 'Vendredi'
      ,pt: 'Sexta'
      ,ro: 'Vineri'
      }
    ,'Saturday' : {
      cs: 'Sobota'
      ,de: 'Samstag'
      ,fr: 'Samedi'
      ,pt: 'Sábado'
      ,ro: 'Sâmbătă'
      }
    ,'Sunday' : {
      cs: 'Neděle'
      ,de: 'Sonntag'
      ,fr: 'Dimanche'
      ,pt: 'Domingo'
      ,ro: 'Duminică'
      }
    ,'Category' : {
      cs: 'Kategorie'
      ,de: 'Kategorie'
      ,fr: 'Catégorie'
      ,pt: 'Categoria'
      ,ro: 'Categorie'
      }
    ,'Subcategory' : {   
      cs: 'Podkategorie'
      ,de: 'Unterkategorie'
      ,fr: 'Sous-catégorie'
      ,pt: 'Subcategoria'
      ,ro: 'Subcategorie'
      }
    ,'Name' : {   
      cs: 'Jméno'
      ,de: 'Name'
      ,fr: 'Nom'
      ,pt: 'Nome'
      ,ro: 'Nume'
      }
    ,'Today' : {   
      cs: 'Dnes'
      ,de: 'Heute'
      ,fr: 'Aujourd\'hui'
      ,pt: 'Hoje'
      ,ro: 'Astăzi'
      }
    ,'Last 2 days' : {   
      cs: 'Poslední 2 dny'
      ,de: 'letzte 2 Tage'
      ,fr: '2 derniers jours'
      ,pt: 'Últimos 2 dias'
      ,ro: 'Ultimele 2 zile'
      }
    ,'Last 3 days' : {   
      cs: 'Poslední 3 dny'
      ,de: 'letzte 3 Tage'
      ,fr: '3 derniers jours'
      ,pt: 'Últimos 3 dias'
      ,ro: 'Ultimele 3 zile'
      }
    ,'Last week' : {   
      cs: 'Poslední týden'
      ,de: 'letzte Woche'
      ,fr: 'Semaine Dernière'
      ,pt: 'Semana passada'
      ,ro: 'Săptămâna trecută'
      }
    ,'Last 2 weeks' : {   
      cs: 'Poslední 2 týdny'
      ,de: 'letzte 2 Wochen'
      ,fr: '2 dernières semaines'
      ,pt: 'Últimas 2 semanas'
      ,ro: 'Ultimele 2 săptămâni'
      }
    ,'Last month' : {   
      cs: 'Poslední měsíc'
      ,de: 'letzter Monat'
      ,fr: 'Mois dernier'
      ,pt: 'Mês passado'
      ,ro: 'Ultima lună'
      }
    ,'Last 3 months' : {   
      cs: 'Poslední 3 měsíce'
      ,de: 'letzte 3 Monate'
      ,fr: '3 derniers mois'
      ,pt: 'Últimos 3 meses'
      ,ro: 'Ultimele 3 luni'
      }
    ,'From' : {   
      cs: 'Od'
      ,de: 'Von'
      ,fr: 'De'
      ,pt: 'De'
      ,ro: 'De la'
      }
    ,'To' : {   
      cs: 'Do'
      ,de: 'Bis'
      ,fr: 'à'
      ,pt: 'Para'
      ,ro: 'La'
      }
    ,'Notes' : {   
      cs: 'Poznámky'
      ,de: 'Notiz'
      ,fr: 'Notes'
      ,pt: 'Notas'
      ,ro: 'Note'
      }
    ,'Food' : {   
      cs: 'Jídlo'
      ,de: 'Essen'
      ,fr: 'Nourriture'
      ,pt: 'Comida'
      ,ro: 'Mâncare'
      }
    ,'Insulin' : {   
      cs: 'Inzulín'
      ,de: 'Insulin'
      ,fr: 'Insuline'
      ,pt: 'Insulina'
      ,ro: 'Insulină'
      }
    ,'Carbs' : {   
      cs: 'Sacharidy'
      ,de: 'Kohlenhydrate'
      ,fr: 'Glucides'
      ,pt: 'Carboidrato'
      ,ro: 'Carbohidrați'
      }
    ,'Notes contain' : {   
      cs: 'Poznámky obsahují'
      ,de: 'Notizen beinhalten'
      ,fr: 'Notes contiennent'
      ,pt: 'Notas contém'
      ,ro: 'Conținut note'
      }
    ,'Event type contains' : {   
      cs: 'Typ události obsahuje'
      ,de: 'Ereignis-Typ beinhaltet'
      ,fr: 'Type d\'événement contient'
      ,pt: 'Tipo de evento contém'
      ,ro: 'Conținut tip de eveniment'
      }
    ,'Target bg range bottom' : {   
      cs: 'Cílová glykémie spodní'
      ,de: 'Untergrenze des Blutzuckerzielbereichs'
      ,fr: 'Limite inférieure glycémie'
      ,pt: 'Limite inferior de glicemia'
      ,ro: 'Limită de jos a glicemiei'
      }
    ,'top' : {   
      cs: 'horní'
      ,de: 'oben'
      ,fr: 'Supérieur'
      ,pt: 'Superior'
      ,ro: 'Sus'
      }
    ,'Show' : {   
      cs: 'Zobraz'
      ,de: 'Zeige'
      ,fr: 'Montrer'
      ,pt: 'Mostrar'
      ,ro: 'Arată'
      }
    ,'Display' : {   
      cs: 'Zobraz'
      ,de: 'Zeige'
      ,fr: 'Afficher'
      ,pt: 'Mostrar'
      ,ro: 'Afișează'
      }
    ,'Loading' : {   
      cs: 'Nahrávám'
      ,de: 'Laden'
      ,fr: 'Chargement'
      ,pt: 'Carregando'
      ,ro: 'Se încarcă'
      }
    ,'Loading profile' : {   
      cs: 'Nahrávám profil'
      ,de: 'Lade Profil'
      ,fr: 'Chargement du profil'
      ,pt: 'Carregando perfil'
      ,ro: 'Încarc profilul'
      }
    ,'Loading status' : {   
      cs: 'Nahrávám status'
      ,de: 'Lade Status'
      ,fr: 'Statut du chargement'
      ,pt: 'Carregando status'
      ,ro: 'Încarc statusul'
      }
    ,'Loading food database' : {   
      cs: 'Nahrávám databázi jídel'
      ,de: 'Lade Essensdatenbank'
      ,fr: 'Chargement de la base de données alimentaire'
      ,pt: 'Carregando dados de alimentos'
      ,ro: 'Încarc baza de date de alimente'
      }
    ,'not displayed' : {   
      cs: 'není zobrazeno'
      ,de: 'nicht angezeigt'
      ,fr: 'non affiché'
      ,pt: 'não mostrado'
      ,ro: 'neafișat'
      }
    ,'Loading CGM data of' : {   
      cs: 'Nahrávám CGM data'
      ,de: 'Lade CGM-Daten von'
      ,fr: 'Chargement données CGM de'
      ,pt: 'Carregando dados de CGM de'
      ,ro: 'Încarc datele CGM ale lui'
      }
    ,'Loading treatments data of' : {   
      cs: 'Nahrávám data ošetření'
      ,de: 'Lade Behandlungsdaten von'
      ,fr: 'Chargement données traitement de'
      ,pt: 'Carregando dados de tratamento de'
      ,ro: 'Încarc datele despre tratament pentru'
      }
    ,'Processing data of' : {   
      cs: 'Zpracovávám data'
      ,de: 'Verarbeite Daten von'
      ,fr: 'Traitement des données de'
      ,pt: 'Processando dados de'
      ,ro: 'Procesez datele lui'
      }
    ,'Portion' : {   
      cs: 'Porce'
      ,de: 'Portion'
      ,fr: 'Portion'
      ,pt: 'Porção'
      ,ro: 'Porție'
      }
    ,'Size' : {   
      cs: 'Rozměr'
      ,de: 'Größe'
      ,fr: 'Taille'
      ,pt: 'Tamanho'
      ,ro: 'Mărime'
      }
    ,'(none)' : {   
      cs: '(Prázdný)'
      ,de: '(nichts)'
      ,fr: '(aucun)'
      ,pt: '(nenhum)'
      ,ro: '(fără)'
      }
    ,'Result is empty' : {   
      cs: 'Prázdný výsledek'
      ,de: 'Leeres Ergebnis'
      ,fr: 'Pas de résultat' 
      ,pt: 'Resultado vazio'
      ,ro: 'Fără rezultat'
      }
// ported reporting
    ,'Day to day' : {   
      cs: 'Den po dni'
      ,fr: 'jour par jour'
      ,pt: 'Dia a dia'
      ,ro: 'Zi cu zi'
      }
    ,'Daily Stats' : {   
      cs: 'Denní statistiky'
      ,fr: 'Stats quotidiennes'
      ,pt: 'Estatísticas diárias'
      ,ro: 'Statistici zilnice'
      }
    ,'Percentile Chart' : {   
      cs: 'Percentil'
      ,fr: 'Percentiles'
      ,pt: 'Percentis'
      ,ro: 'Grafic percentile'
      }
    ,'Distribution' : {   
      cs: 'Rozložení'
      ,fr: 'Distribution'
      ,pt: 'Distribuição'
      ,ro: 'Distribuție'
	  }
    ,'Hourly stats' : {   
      cs: 'Statistika po hodinách'
      ,fr: 'Statistiques horaires'
      ,pt: 'Estatísticas por hora'
      ,ro: 'Statistici orare'
	  }
    ,'Weekly success' : {   
      cs: 'Statistika po týdnech'
      ,fr: 'Résultat hebdomadaire'
      ,pt: 'Resultados semanais'
      ,ro: 'Rezultate săptămânale'
      }
    ,'No data available' : {   
      cs: 'Žádná dostupná data'
      ,fr: 'Pas de données disponibles'
      ,pt: 'não há dados'
      ,ro: 'Fără date'
      }
    ,'Low' : {   
      cs: 'Nízká'
      ,fr: 'Bas'
      ,pt: 'Baixo'
      ,ro: 'Prea jos'
      }
    ,'In Range' : {   
      cs: 'V rozsahu'
      ,fr: 'dans la norme'
      ,pt: 'Na meta'
      ,ro: 'În interval'
      }
    ,'Period' : {   
      cs: 'Období'
      ,fr: 'Période'
      ,pt: 'Período'
      ,ro: 'Perioada'
      }
    ,'High' : {   
      cs: 'Vysoká'
      ,fr: 'Haut'
      ,pt: 'Alto'
      ,ro: 'Prea sus'
      }
    ,'Average' : {   
      cs: 'Průměrná'
      ,fr: 'Moyenne'
      ,pt: 'Média'
      ,ro: 'Media'
      }
    ,'Low Quartile' : {   
      cs: 'Nízký kvartil'
      ,fr: 'Quartile inférieur'
      ,pt: 'Quartil inferior'
      ,ro: 'Pătrime inferioară'
      }
    ,'Upper Quartile' : {   
      cs: 'Vysoký kvartil'
      ,fr: 'Quartile supérieur'
      ,pt: 'Quartil superior'
      ,ro: 'Pătrime superioară'
      }
    ,'Quartile' : {   
      cs: 'Kvartil'
      ,fr: 'Quartile'
      ,pt: 'Quartil'
      ,ro: 'Pătrime'
      }
    ,'Date' : {   
      cs: 'Datum'
      ,fr: 'Date'
      ,pt: 'Data'
      ,ro: 'Data'
      }
    ,'Normal' : {   
      cs: 'Normální'
      ,fr: 'Normale'
      ,pt: 'Normal'
      ,ro: 'Normal'
      }
    ,'Median' : {   
      cs: 'Medián'
      ,fr: 'Médiane'
      ,pt: 'Mediana'
      ,ro: 'Mediană'
      }
    ,'Readings' : {   
      cs: 'Záznamů'
      ,fr: 'Valeurs'
      ,pt: 'Valores'
      ,ro: 'Valori'
      }
    ,'StDev' : {   
      cs: 'St. odchylka'
      ,fr: 'Déviation St.'
      ,pt: 'DesvPadr'
      ,ro: 'Dev Std'
      }
    ,'Daily stats report' : {   
      cs: 'Denní statistiky'
      ,fr: 'Rapport quotidien'
      ,pt: 'Relatório diário'
      ,ro: 'Raport statistică zilnică'
      }
    ,'Glucose Percentile report' : {   
      cs: 'Tabulka percentil glykémií'
      ,fr: 'Rapport precentiles Glycémie'
      ,pt: 'Relatório de Percentis de Glicemia'
      ,ro: 'Raport percentile glicemii'
      }
    ,'Glucose distribution' : {   
      cs: 'Rozložení glykémií'
      ,fr: 'Distribution glycémies'
      ,pt: 'Distribuição de glicemias'
      ,ro: 'Distribuție glicemie'
      }
    ,'days total' : {   
      cs: 'dní celkem'
      ,fr: 'jours totaux'
      ,pt: 'dias total'
      ,ro: 'total zile'
      }
    ,'Overall' : {   
      cs: 'Celkem'
      ,fr: 'Dans l\'ensemble'
      ,pt: 'Geral'
      ,ro: 'General'
      }
    ,'Range' : {   
      cs: 'Rozsah'
      ,fr: 'Intervalle'
      ,pt: 'intervalo'
      ,ro: 'Interval'
      }
    ,'% of Readings' : {   
      cs: '% záznamů'
      ,pt: '% de valores'
      ,ro: '% de valori'
      }
    ,'# of Readings' : {   
      cs: 'počet záznamů'
      ,fr: 'nbr de valeurs'
      ,pt: 'N° de valores'
      ,ro: 'nr. de valori'
      }
    ,'Mean' : {   
      cs: 'Střední hodnota'
      ,fr: 'Moyenne'
      ,pt: 'Média'
      ,ro: 'Medie'
      }
    ,'Standard Deviation' : {   
      cs: 'Standardní odchylka'
      ,fr: 'Déviation Standard'
      ,pt: 'Desvio padrão'
      ,ro: 'Deviație standard'
      }
    ,'Max' : {   
      cs: 'Max'
      ,fr: 'Max'
      ,pt: 'Max'
      ,ro: 'Max'
      }
    ,'Min' : {   
      cs: 'Min'
      ,fr: 'Min'
      ,pt: 'Min'
      ,ro: 'Min'
      }
    ,'A1c estimation*' : {   
      cs: 'Předpokládané HBA1c*'
      ,fr: 'Estimation HbA1c*'
      ,pt: 'A1c estimada'
      ,ro: 'HbA1C estimată'
      }
    ,'Weekly Success' : {   
      cs: 'Týdenní úspěšnost'
      ,fr: 'Réussite hebdomadaire'
      ,pt: 'Resultados semanais'
      ,ro: 'Rezultate săptămânale'
      }
    ,'There is not sufficient data to run this report. Select more days.' : {   
      cs: 'Není dostatek dat. Vyberte delší časové období.'
      ,fr: 'Pas assez de données pour un rapport. Sélectionnez plus de jours.'
      ,pt: 'Não há dados suficientes. Selecione mais dias'
      ,ro: 'Nu sunt sufieciente date pentru acest raport. Selectați mai multe zile.'
	  }
// food editor
    ,'Using stored API secret hash' : {   
      cs: 'Používám uložený hash API hesla'
      ,fr: 'Utilisation du hash API existant'
      ,pt: 'Usando o hash de API existente'
      ,ro: 'Utilizez cheie API secretă'
      }
    ,'No API secret hash stored yet. You need to enter API secret.' : {   
      cs: 'Není uložený žádný hash API hesla. Musíte zadat API heslo.'
      ,fr: 'Pas de secret API existant. Vous devez en entrer un.'
      ,pt: 'Hash de segredo de API inexistente. Entre um segredo de API'
      ,ro: 'Încă nu există cheie API secretă. Aceasta trebuie introdusă.'
      }
    ,'Database loaded' : {   
      cs: 'Databáze načtena'
      ,fr: 'Base de données chargée'
      ,pt: 'Banco de dados carregado'
      ,ro: 'Baza de date încărcată'
      }
    ,'Error: Database failed to load' : {   
      cs: 'Chyba při načítání databáze'
      ,fr: 'Erreur, le chargement de la base de données a échoué'
      ,pt: 'Erro: Banco de dados não carregado'
      ,ro: 'Eroare: Nu s-a încărcat baza de date'
      }
    ,'Create new record' : {   
      cs: 'Vytvořit nový záznam'
      ,fr: 'Créer nouvel enregistrement'
      ,pt: 'Criar novo registro' 
      ,ro: 'Crează înregistrare nouă'
      }
    ,'Save record' : {   
      cs: 'Uložit záznam'
      ,fr: 'Sauver enregistrement'
      ,pt: 'Salvar registro'
      ,ro: 'Salvează înregistrarea'
      }
    ,'Portions' : {   
      cs: 'Porcí'
      ,fr: 'Portions'
      ,pt: 'Porções'
      ,ro: 'Porții'
      }
    ,'Unit' : {   
      cs: 'Jedn'
      ,fr: 'Unités'
      ,pt: 'Unidade'
      ,ro: 'Unități'
      }
    ,'GI' : {   
      cs: 'GI'
      ,fr: 'IG'
      ,pt: 'IG'
      ,ro: 'CI'
      }
    ,'Edit record' : {   
      cs: 'Upravit záznam'
      ,fr: 'Modifier enregistrement'
      ,pt: 'Editar registro'
      ,ro: 'Editează înregistrarea'
      }
    ,'Delete record' : {   
      cs: 'Smazat záznam'
      ,fr: 'Effacer enregistrement'
      ,pt: 'Apagar registro'
      ,ro: 'Șterge înregistrarea'
      }
    ,'Move to the top' : {   
      cs: 'Přesuň na začátek'
      ,fr: 'Déplacer au sommet'
      ,pt: 'Mover para o topo'
      ,ro: 'Mergi la început'
      }
    ,'Hidden' : {   
      cs: 'Skrytý'
      ,fr: 'Caché'
      ,pt: 'Oculto'
      ,ro: 'Ascuns'
      }
    ,'Hide after use' : {   
      cs: 'Skryj po použití'
      ,fr: 'Cacher après utilisation'
      ,pt: 'Ocultar após uso'
      ,ro: 'Ascunde după folosireaa'
      }
    ,'Your API secret must be at least 12 characters long' : {   
      cs: 'Vaše API heslo musí mít alespoň 12 znaků'
      ,fr: 'Votre secret API doit contenir au moins 12 caractères'
      ,pt: 'Seu segredo de API deve conter no mínimo 12 caracteres'
      ,ro: 'Cheia API trebuie să aibă mai mult de 12 caractere'
      }
    ,'Bad API secret' : {   
      cs: 'Chybné API heslo'
      ,fr: 'Secret API erroné'
      ,pt: 'Segredo de API fraco'
      ,ro: 'Cheie API greșită'
      }
    ,'API secret hash stored' : {   
      cs: 'Hash API hesla uložen'
      ,fr: 'Hash API secret sauvegardé'
      ,pt: 'Segredo de API guardado'
      ,ro: 'Cheie API înregistrată'
      }
    ,'Status' : {   
      cs: 'Status'
      ,fr: 'Statut'
      ,pt: 'Status'
      ,ro: 'Status'
      }
    ,'Not loaded' : {   
      cs: 'Nenačtený'
      ,fr: 'Non chargé'
      ,pt: 'Não carregado'
      ,ro: 'Neîncărcat'
      }
    ,'Food editor' : {   
      cs: 'Editor jídel'
      ,fr: 'Editeur aliments'
      ,pt: 'Editor de alimentos'
      ,ro: 'Editor alimente'
      }
    ,'Your database' : {   
      cs: 'Vaše databáze'
      ,fr: 'Votre base de données'
      ,pt: 'Seu banco de dados'
      ,ro: 'Baza de date'
      }
    ,'Filter' : {   
      cs: 'Filtr'
      ,fr: 'Filtre'
      ,pt: 'Filtro'
      ,ro: 'Filtru'
      }
    ,'Save' : {   
      cs: 'Ulož'
      ,fr: 'Sauver'
      ,pt: 'Salvar'
      ,ro: 'Salvează'
      }
    ,'Clear' : {   
      cs: 'Vymaž'
      ,fr: 'Effacer'
      ,pt: 'Apagar'
      ,ro: 'Inițializare'
      }
    ,'Record' : {   
      cs: 'Záznam'
      ,fr: 'Enregistrement'
      ,pt: 'Gravar'
      ,ro: 'Înregistrare'
      }
    ,'Quick picks' : {   
      cs: 'Rychlý výběr'
      ,fr: 'Sélection rapide'
      ,pt: 'Seleção rápida'
      ,ro: 'Selecție rapidă'
      }
    ,'Show hidden' : {   
      cs: 'Zobraz skryté'
      ,fr: 'Montrer cachés'
      ,pt: 'Mostrar ocultos'
      ,ro: 'Arată înregistrările ascunse'
      }
    ,'Your API secret' : {   
      cs: 'Vaše API heslo'
      ,fr: 'Votre secret API'
      ,pt: 'Seu segredo de API'
      ,ro: 'Cheia API'
      }
    ,'Store hash on this computer (Use only on private computers)' : {   
      cs: 'Ulož hash na tomto počítači (používejte pouze na soukromých počítačích)'
      ,fr: 'Sauver le hash sur cet ordinateur (privé uniquement)'
      ,pt: 'Salvar hash nesse computador (Somente em computadores privados)'
      ,ro: 'Salvează cheia pe acest PC (Folosiți doar PC de încredere)'
      }
    ,'Treatments' : {   
      cs: 'Ošetření'
      ,fr: 'Traitements'
      ,pt: 'Tratamentos'
      ,ro: 'Tratamente'
      }
    ,'Time' : {   
      cs: 'Čas'
      ,fr: 'Heure'
      ,pt: 'Hora'
      ,ro: 'Ora'
      }
    ,'Event Type' : {   
      cs: 'Typ události'
      ,fr: 'Type d\'événement'
      ,pt: 'Tipo de evento'
      ,ro: 'Tip eveniment'
      }
    ,'Blood Glucose' : {   
      cs: 'Glykémie'
      ,fr: 'Glycémie'
      ,pt: 'Glicemia'
      ,ro: 'Glicemie'
      }
    ,'Entered By' : {   
      cs: 'Zadal'
      ,fr: 'Entré par'
      ,pt: 'Inserido por'
      ,ro: 'Introdus de'
      }
    ,'Delete this treatment?' : {   
      cs: 'Vymazat toto ošetření?'
      ,fr: 'Effacer ce traitement?'
      ,pt: 'Apagar este tratamento'
      ,ro: 'Șterge acest eveniment?'
      }
    ,'Carbs Given' : {   
      cs: 'Sacharidů'
      ,fr: 'Glucides donnés'
      ,pt: 'Carboidratos'
      ,ro: 'Carbohidrați'
      }
    ,'Inzulin Given' : {   
      cs: 'Inzulínu'
      ,fr: 'Insuline donnée'
      ,pt: 'Insulina'
      ,ro: 'Insulină administrată'
      }
    ,'Event Time' : {   
      cs: 'Čas události'
      ,fr: 'Heure de l\'événement'
      ,pt: 'Hora do evento'
      ,ro: 'Ora evenimentului'
      }
    ,'Please verify that the data entered is correct' : {   
      cs: 'Prosím zkontrolujte, zda jsou údaje zadány správně'
      ,fr: 'Merci de vérifier la correction des données entrées'
      ,pt: 'Favor verificar se os dados estão corretos'
      ,ro: 'Verificați conexiunea datelor introduse'
      }
    ,'BG' : {   
      cs: 'Glykémie'
      ,fr: 'Glycémie'
      ,pt: 'Glicemia'
      ,ro: 'Glicemie'
      }
    ,'Use BG correction in calculation' : {   
      cs: 'Použij korekci na glykémii'
      ,fr: 'Utiliser la correction de glycémie dans les calculs'
      ,pt: 'Usar correção de glicemia nos cálculos'
      ,ro: 'Folosește corecția de glicemie în calcule'
      }
    ,'BG from CGM (autoupdated)' : {   
      cs: 'Glykémie z CGM (automaticky aktualizovaná)'
      ,fr: 'Glycémie CGM (automatique)'
      ,pt: 'Glicemia do sensor (Automático)'
      ,ro: 'Glicemie în senzor (automat)'
      }
    ,'BG from meter' : {   
      cs: 'Glykémie z glukoměru'
      ,fr: 'Glycémie glucomètre'
      ,pt: 'Glicemia do glicosímetro'
      ,ro: 'Glicemie în glucometru'
      }
    ,'Manual BG' : {   
      cs: 'Ručně zadaná glykémie'
      ,fr: 'Glycémie manuelle'
      ,pt: 'Glicemia Manual'
      ,ro: 'Glicemie manuală'
      }
    ,'Quickpick' : {   
      cs: 'Rychlý výběr'
      ,fr: 'Sélection rapide'
      ,pt: 'Seleção rápida'
      ,ro: 'Selecție rapidă'
      }
    ,'or' : {   
      cs: 'nebo'
      ,fr: 'ou'
      ,pt: 'or'
      ,ro: 'sau'
      }
    ,'Add from database' : {   
      cs: 'Přidat z databáze'
      ,fr: 'Ajouter à partir de la base de données'
      ,pt: 'Adicionar do banco de dados'
      ,ro: 'Adaugă din baza de date'
      }
    ,'Use carbs correction in calculation' : {   
      cs: 'Použij korekci na sacharidy'
      ,fr: 'Utiliser la correction en glucides dans les calculs'
      ,pt: 'Usar correção com carboidratos no cálculo'
      ,ro: 'Folosește corecția de carbohidrați în calcule'
      }
    ,'Use COB correction in calculation' : {   
      cs: 'Použij korekci na COB'
      ,fr: 'Utiliser les COB dans les calculs'
      ,pt: 'Usar COB no cálculo'
      ,ro: 'Folosește COB în calcule'
      }
    ,'Use IOB in calculation' : {   
      cs: 'Použij IOB ve výpočtu'
      ,fr: 'Utiliser l\'IOB dans les calculs'
      ,pt: 'Usar IOB no cálculo'
      ,ro: 'Folosește IOB în calcule'
      }
    ,'Other correction' : {   
      cs: 'Jiná korekce'
      ,fr: 'Autre correction'
      ,pt: 'Outra correção'
      ,ro: 'Alte corecții'
      }
    ,'Rounding' : {   
      cs: 'Zaokrouhlení'
      ,fr: 'Arrondi'
      ,pt: 'Arredondamento'
      ,ro: 'Rotunjire'
	  }
    ,'Enter insulin correction in treatment' : {   
      cs: 'Zahrň inzulín do záznamu ošetření'
      ,fr: 'Entrer correction insuline dans le traitement'
      ,pt: 'Inserir correção de insulina no tratamento'
      ,ro: 'Introdu corecția de insulină în tratament'
      }
    ,'Insulin needed' : {   
      cs: 'Potřebný inzulín'
      ,fr: 'Insuline nécessaire'
      ,pt: 'Insulina necessária'
      ,ro: 'Necesar insulină' 
      }
    ,'Carbs needed' : {   
      cs: 'Potřebné sach'
      ,fr: 'Glucides nécessaires'
      ,pt: 'Carboidratos necessários'
      ,ro: 'Necesar carbohidrați'
      }
    ,'Carbs needed if Insulin total is negative value' : {   
      cs: 'Chybějící sacharidy v případě, že výsledek je záporný'
      ,fr: 'Glucides nécessaires si insuline totale négative'
      ,pt: 'Carboidratos necessários se Insulina total for negativa'
      ,ro: 'Carbohidrați când necesarul de insulină este negativ'
      }
    ,'Basal rate' : {   
      cs: 'Bazál'
      ,fr: 'Taux basal'
      ,pt: 'Taxa basal'
      ,ro: 'Rata bazală'
      }
    ,'60 minutes ealier' : {   
      cs: '60 min předem'
      ,fr: '60 min avant'
      ,pt: '60 min antes'
      ,ro: 'acum 60 min'
      }
    ,'45 minutes ealier' : {   
      cs: '45 min předem'
      ,fr: '45 min avant'
      ,pt: '45 min antes'
      ,ro: 'acum 45 min'
      }
    ,'30 minutes ealier' : {   
      cs: '30 min předem'
      ,fr: '30 min avant'
      ,pt: '30 min antes'
      ,ro: 'acum 30 min'
      }
    ,'20 minutes ealier' : {   
      cs: '20 min předem'
      ,fr: '20 min avant'
      ,pt: '20 min antes'
      ,ro: 'acum 20 min'
      }
    ,'15 minutes ealier' : {   
      cs: '15 min předem'
      ,fr: '15 min avant'
      ,pt: '15 min antes'
      ,ro: 'acu 15 min'
      }
    ,'Time in minutes' : {   
      cs: 'Čas v minutách'
      ,fr: 'Durée en minutes'
      ,pt: 'Tempo em minutos'
      ,ro: 'Timp în minute'
      }
    ,'15 minutes later' : {   
      cs: '15 min po'
      ,fr: '15 min après'
      ,ro: 'după 15 min'
      }
    ,'20 minutes later' : {   
      cs: '20 min po'
      ,fr: '20 min après'
      ,pt: '20 min depois'
      ,ro: 'după 20 min'
      }
    ,'30 minutes later' : {   
      cs: '30 min po'
      ,fr: '30 min après'
      ,pt: '30 min depois'
      ,ro: 'după 30 min'
      }
    ,'45 minutes later' : {   
      cs: '45 min po'
      ,fr: '45 min après'
      ,pt: '45 min depois'
      ,ro: 'după 45 min'
      }
    ,'60 minutes later' : {   
      cs: '60 min po'
      ,fr: '60 min après'
      ,pt: '60 min depois'
      ,ro: 'după 60 min'
      }
    ,'Additional Notes, Comments' : {   
      cs: 'Dalši poznámky, komentáře'
      ,fr: 'Notes additionnelles, commentaires'
      ,pt: 'Notas adicionais e comentários'
      ,ro: 'Note adiționale, comentarii'
      }
    ,'RETRO MODE' : {   
      cs: 'V MINULOSTI'
      ,fr: 'MODE RETROSPECTIF'
      ,pt: 'Modo Retrospectivo'
      ,ro: 'MOD RETROSPECTIV'
      }
    ,'Now' : {   
      cs: 'Nyní'
      ,fr: 'Maintenant'
      ,pt: 'Agora'
      ,ro: 'Acum'
      }
    ,'Other' : {   
      cs: 'Jiný'
      ,fr: 'Autre'
      ,pt: 'Outro'
      ,ro: 'Altul'
      }
    ,'Submit Form' : {   
      cs: 'Odeslat formulář'
      ,fr: 'Formulaire de soumission'
      ,pt: 'Submeter formulário'
      ,ro: 'Trimite formularul'
      }
    ,'Profile editor' : {   
      cs: 'Editor profilu'
      ,fr: 'Editeur de profil'
      ,pt: 'Editor de perfil'
      ,ro: 'Editare profil'
      }
    ,'Reporting tool' : {   
      cs: 'Výkazy'
      ,fr: 'Outil de rapport'
      ,pt: 'Ferramenta de relatórios'
      ,ro: 'Instrument de rapoarte'
      }
    ,'Add food from your database' : {   
      cs: 'Přidat jidlo z Vaší databáze'
      ,fr: 'Ajouter aliment de votre base de données'
      ,pt: 'Incluir alimento do seu banco de dados'
      ,ro: 'Adaugă alimente din baza de date'
      }
    ,'Reload database' : {   
      cs: 'Znovu nahraj databázi'
      ,fr: 'Recharger la base de données'
      ,pt: 'Recarregar banco de dados'
      ,ro: 'Reîncarcă baza de date'
      }
    ,'Add' : {   
      cs: 'Přidej'
      ,fr: 'Ajouter'
      ,pt: 'Adicionar'
      ,ro: 'Adaugă'
      }
    ,'Unauthorized' : {   
      cs: 'Neautorizováno'
      ,fr: 'Non autorisé'
      ,pt: 'Não autorizado'
      ,ro: 'Neautorizat'
      }
    ,'Entering record failed' : {   
      cs: 'Vložení záznamu selhalo'
      ,fr: 'Entrée enregistrement a échoué'
      ,pt: 'Entrada de registro falhou'
      ,ro: 'Înregistrare eșuată'
      }
    ,'Device authenticated' : {   
      cs: 'Zařízení ověřeno'
      ,fr: 'Appareil authentifié'
      ,pt: 'Dispositivo autenticado'
      ,ro: 'Dispozitiv autentificat'
      }
    ,'Device not authenticated' : {   
      cs: 'Zařízení není ověřeno'
      ,fr: 'Appareil non authentifié'
      ,pt: 'Dispositivo não autenticado'
      ,ro: 'Dispozitiv neautentificat'
      }
    ,'Authentication status' : {   
      cs: 'Stav ověření'
      ,fr: 'Status de l\'authentification'
      ,pt: 'Status de autenticação'
      ,ro: 'Starea autentificării'
      }
    ,'Authenticate' : {   
      cs: 'Ověřit'
      ,fr: 'Authentifier'
      ,pt: 'Autenticar'
      ,ro: 'Autentificare'
      }
    ,'Remove' : {   
      cs: 'Vymazat'
      ,fr: 'Retirer'
      ,pt: 'Remover'
      ,ro: 'Șterge'
      }
    ,'Your device is not authenticated yet' : {   
      cs: 'Toto zařízení nebylo dosud ověřeno'
      ,fr: 'Votre appareil n\'est pas encore authentifié'
      ,pt: 'Seu dispositivo ainda não foi autenticado'
      ,ro: 'Dispozitivul nu este autentificat încă'
      }
    ,'Sensor' : {   
      cs: 'Senzor'
      ,fr: 'Senseur'
      ,pt: 'Sensor'
      ,ro: 'Senzor'
      }
    ,'Finger' : {   
      cs: 'Glukoměr'
      ,fr: 'Doigt'
      ,pt: 'Dedo'
      ,ro: 'Deget'
      }
    ,'Manual' : {   
      cs: 'Ručně'
      ,fr: 'Manuel'
      ,pt: 'Manual'
      ,ro: 'Manual'
      }
    ,'Scale' : {   
      cs: 'Měřítko'
      ,fr: 'Echelle'
      ,pt: 'Escala'
      ,ro: 'Scală'
      }
    ,'Linear' : {   
      cs: 'lineární'
      ,fr: 'Linéaire'
      ,pt: 'Linear'
      ,ro: 'Liniar'
      }
    ,'Logarithmic' : {   
      cs: 'logaritmické'
      ,fr: 'Logarithmique'
      ,pt: 'Logarítmica'
      ,ro: 'Logaritmic'
      }
    ,'Silence for 30 minutes' : {   
      cs: 'Ztlumit na 30 minut'
      ,fr: 'Silence pendant 30 minutes'
      ,pt: 'Silenciar por 30 minutos'
      ,ro: 'Ignoră pentru 30 minute'
      }
    ,'Silence for 60 minutes' : {   
      cs: 'Ztlumit na 60 minut'
      ,fr: 'Silence pendant 60 minutes'
      ,pt: 'Silenciar por 60 minutos'
      ,ro: 'Ignoră pentru 60 minute'
      }
    ,'Silence for 90 minutes' : {   
      cs: 'Ztlumit na 90 minut'
      ,fr: 'Silence pendant 90 minutes'
      ,pt: 'Silenciar por 90 minutos'
      ,ro: 'Ignoră pentru 90 minure'
      }
    ,'Silence for 120 minutes' : {   
      cs: 'Ztlumit na 120 minut'
      ,fr: 'Silence pendant 120 minutes'
      ,pt: 'Silenciar por 120 minutos'
      ,ro: 'Ignoră pentru 120 minute'
      }
    ,'3HR' : {   
      cs: '3hod'
      ,fr: '3hr'
      ,pr: '3h'
      ,ro: '3h'
      }
    ,'6HR' : {   
      cs: '6hod'
      ,fr: '6hr'
      ,pr: '6h'
      ,ro: '6h'
      }
    ,'12HR' : {   
      cs: '12hod'
      ,fr: '12hr'
      ,pr: '12h'
      ,ro: '12h'
      }
    ,'24HR' : {   
      cs: '24hod'
      ,fr: '24hr'
      ,pr: '24h'
      ,ro: '24h'
      }
    ,'Sttings' : {   
      cs: 'Nastavení'
      ,fr: 'Paramètres'
      ,pr: 'Definições'
      ,ro: 'Setări'
      }
    ,'Units' : {   
      cs: 'Jednotky'
      ,fr: 'Unités'
      ,pr: 'Unidades'
      ,ro: 'Unități'
      }
    ,'Date format' : {   
      cs: 'Formát datumu'
      ,fr: 'Format Date'
      ,pr: 'Formato de data'
      ,ro: 'Formatul datei'
      }
    ,'12 hours' : {   
      cs: '12 hodin'
      ,fr: '12hr'
      ,pr: '12 horas'
      ,ro: '12 ore'
      }
    ,'24 hours' : {   
      cs: '24 hodin'
      ,fr: '24hr'
      ,pr: '24 horas'
      ,ro: '24 ore'
      }
    ,'Log a Treatment' : {   
      cs: 'Záznam ošetření'
      ,fr: 'Entrer un traitement'
      ,pr: 'Entre um tratamento'
      ,ro: 'Înregistrează un eveniment'
      }
    ,'BG Check' : {   
      cs: 'Kontrola glykémie'
      ,fr: 'Contrôle glycémie'
      ,pr: 'Medida de glicemia'
      ,ro: 'Verificare glicemie'
      }
    ,'Meal Bolus' : {   
      cs: 'Bolus na jídlo'
      ,fr: 'Bolus repas'
      ,pr: 'Bolus de refeição'
      ,ro: 'Bolus masă'
      }
    ,'Snack Bolus' : {   
      cs: 'Bolus na svačinu'
      ,fr: 'Bolus friandise'
      ,pr: 'Bolus de lanche'
      ,ro: 'Bolus gustare'
      }
    ,'Correction Bolus' : {   
      cs: 'Bolus na glykémii'
      ,fr: 'Bolus de correction'
      ,pr: 'Bolus de correção'
      ,ro: 'Bolus corecție'
      }
    ,'Carb Correction' : {   
      cs: 'Přídavek sacharidů'
      ,fr: 'Correction glucide'
      ,pr: 'Carboidrato de correção'
      ,ro: 'Corecție de carbohidrați'
      }
    ,'Note' : {   
      cs: 'Poznámka'
      ,fr: 'Note'
      ,pr: 'Nota'
      ,ro: 'Notă'
      }
    ,'Question' : {   
      cs: 'Otázka'
      ,fr: 'Question'
      ,pr: 'Pergunta'
      ,ro: 'Întrebare'
      }
    ,'Exercise' : {   
      cs: 'Cvičení'
      ,fr: 'Exercice'
      ,pr: 'Exercício'
      ,ro: 'Activitate fizică'
      }
    ,'Pump Site Change' : {   
      cs: 'Přepíchnutí kanyly'
      ,fr: 'Changement de site pompe'
      ,pr: 'Troca de catéter'
      ,ro: 'Schimbare loc pompă'
      }
    ,'Sensor Start' : {   
      cs: 'Spuštění sensoru'
      ,fr: 'Démarrage senseur'
      ,pr: 'Início de sensor'
      ,ro: 'Start senzor'
      }
    ,'Sensor Change' : {   
      cs: 'Výměna sensoru'
      ,fr: 'Changement senseur'
      ,pr: 'Troca de sensor'
      ,ro: 'Schimbare senzor'
      }
    ,'Dexcom Sensor Start' : {   
      cs: 'Spuštění sensoru'
      ,fr: 'Démarrage senseur Dexcom'
      ,pr: 'Início de sensor Dexcom'
      ,ro: 'Pornire senzor Dexcom'
      }
    ,'Dexcom Sensor Change' : {   
      cs: 'Výměna sensoru'
      ,fr: 'Changement senseur Dexcom'
      ,pr: 'Troca de sensor Dexcom'
      ,ro: 'Schimbare senzor Dexcom'
      }
    ,'Insulin Cartridge Change' : {   
      cs: 'Výměna inzulínu'
      ,fr: 'Changement cartouche d\'insuline'
      ,pr: 'Troca de reservatório de insulina'
      ,ro: 'Schimbare cartuș insulină'
      }
    ,'D.A.D. Alert' : {   
      cs: 'D.A.D. Alert'
      ,fr: 'Wouf! Wouf! Chien d\'alerte diabète'
      ,pr: 'Alerta de cão sentinela de diabetes'
      ,ro: 'Alertă câine de serviciu'
      }
    ,'Glucose Reading' : {   
      cs: 'Hodnota glykémie'
      ,fr: 'Valeur de glycémie'
      ,pr: 'Valor de glicemia'
      ,ro: 'Valoare glicemie'
      }
    ,'Measurement Method' : {   
      cs: 'Metoda měření'
      ,fr: 'Méthode de mesure'
      ,pr: 'Método de medida'
      ,ro: 'Metodă măsurare'
      }
    ,'Meter' : {   
      cs: 'Glukoměr'
      ,fr: 'Glucomètre'
      ,pr: 'Glicosímetro'
      ,ro: 'Glucometru'
      }
    ,'Insulin Given' : {   
      cs: 'Inzulín'
      ,fr: 'Insuline donnée'
      ,pr: 'Insulina'
      ,ro: 'Insulină administrată'
      }
    ,'Amount in grams' : {   
      cs: 'Množství v gramech'
      ,fr: 'Quantité en grammes'
      ,pr: 'Quantidade em gramas'
      ,ro: 'Cantitate în grame'
      }
    ,'Amount in units' : {   
      cs: 'Množství v jednotkách'
      ,fr: 'Quantité en unités'
      ,pr: 'Quantidade em unidades'
      ,ro: 'Cantitate în unități'
      }
    ,'View all treatments' : {   
      cs: 'Zobraz všechny ošetření'
      ,fr: 'Voir tous les traitements'
      ,pr: 'Visualizar todos os tratamentos'
      ,ro: 'Vezi toate evenimentele'
      }
    ,'Enable Alarms' : {   
      cs: 'Povolit alarmy'
      ,fr: 'Activer les alarmes'
      ,pr: 'Ativar alarmes'
      ,ro: 'Activează alarmele'
      }
    ,'When enabled an alarm may sound.' : {   
      cs: 'Při povoleném alarmu zní zvuk'
      ,fr: 'Si activée, un alarme peut sonner.'
      ,pr: 'Quando ativado, um alarme poderá soar'
      ,ro: 'Când este activ, poate suna o alarmă.'
      }
    ,'Urgent High Alarm' : {   
      cs: 'Urgentní vysoká glykémie'
      ,fr: 'Alarme haute urgente'
      ,pr: 'Alarme de alto urgente'
      ,ro: 'Alarmă urgentă hiper'
      }
    ,'High Alarm' : {   
      cs: 'Vysoká glykémie'
      ,fr: 'Alarme haute'
      ,pr: 'Alarme de alto'
      ,ro:  'Alarmă hiper'
      }
    ,'Low Alarm' : {   
      cs: 'Nízká glykémie'
      ,fr: 'Alarme basse'
      ,pr: 'Alarme de baixo'
      ,ro: 'Alarmă hipo'
      }
    ,'Urgent Low Alarm' : {   
      cs: 'Urgentní nízká glykémie'
      ,fr: 'Alarme basse urgente'
      ,pr: 'Alarme de baixo urgente'
      ,ro: 'Alarmă urgentă hipo'
      }
    ,'Stale Data: Warn' : {   
      cs: 'Zastaralá data'
      ,fr: 'Données dépassées'
      ,pr: 'Dados antigos: aviso'
      ,ro: 'Date învechite: alertă'
      }
    ,'Stale Data: Urgent' : {   
      cs: 'Zastaralá data urgentní'
      ,fr: 'Données dépassées urgentes'
      ,pr: 'Dados antigos: Urgente'
      ,ro: 'Date învechite: urgent'
      }
    ,'mins' : {   
      cs: 'min'
      ,fr: 'mins'
      ,pr: 'min'
      ,ro: 'min'
      }
    ,'Night Mode' : {   
      cs: 'Noční mód'
      ,fr: 'Mode nocturne'
      ,pr: 'Modo noturno'
      ,ro: 'Mod nocturn'
      }
    ,'When enabled the page will be dimmed from 10pm - 6am.' : {   
      cs: 'Když je povoleno, obrazovka je ztlumena 22:00 - 6:00'
      ,fr: 'Si activé, la page sera assombire de 22:00 à 6:00'
      ,pr: 'Se ativado, a página será escurecida de 22h a 6h'
      ,ro: 'La activare va scădea iluminarea între 22 și 6'
      }
    ,'Enable' : {   
      cs: 'Povoleno'
      ,fr: 'activer'
      ,pr: 'Ativar'
      ,ro: 'Activează'
      }
    ,'Settings' : {   
      cs: 'Nastavení'
      ,fr: 'Paramètres'
      ,pr: 'Definições'
      ,ro: 'Setări'
      }
    ,'Show Raw BG Data' : {   
      cs: 'Zobraz RAW data'
      ,fr: 'Montrer les données BG brutes'
      ,pr: 'Mostrar dados de glicemia não processados'
      ,ro: 'Afișează date primare glicemie'
      }
    ,'Never' : {   
      cs: 'Nikdy'
      ,fr: 'Jamais'
      ,pr: 'Nunca'
      ,ro: 'Niciodată'
      }
    ,'Always' : {   
      cs: 'Vždy'
      ,fr: 'Toujours'
      ,pr: 'Sempre'
      ,ro: 'Întotdeauna'
      }
    ,'When there is noise' : {   
      cs: 'Při šumu'
      ,fr: 'Quand il y a du bruit'
      ,pr: 'Quando houver ruído'
      ,ro: 'Atunci când este diferență'
      }
    ,'When enabled small white dots will be disaplyed for raw BG data' : {   
      cs: 'Když je povoleno, malé tečky budou zobrazeny pro RAW data'
      ,fr: 'Si activé, des points blancs représenteront les données brutes'
      ,pr: 'Se ativado, pontinhos brancos representarão os dados de glicemia não processados'
      ,ro: 'La activare vor apărea puncte albe reprezentând citirea brută a glicemiei'
      }
    ,'Custom Title' : {   
      cs: 'Vlastní název stránky'
      ,fr: 'Titre sur mesure'
      ,pr: 'Customizar Título'
      ,ro: 'Titlu particularizat'
      }
    ,'Theme' : {   
      cs: 'Téma'
      ,fr: 'Thème'
      ,pr: 'tema'
      ,ro: 'Temă'
      }
    ,'Default' : {   
      cs: 'Výchozí'
      ,fr: 'Par défaut'
      ,pr: 'Padrão'
      ,ro: 'Implicită'
      }
    ,'Colors' : {   
      cs: 'Barevné'
      ,fr: 'Couleurs'
      ,pr: 'Cores'
      ,ro: 'Colorată'
      }
    ,'Reset, and use defaults' : {   
      cs: 'Vymaž a nastav výchozí hodnoty'
      ,fr: 'Remise à zéro et utilisation des valeurs par défaut'
      ,pr: 'Zerar e usar padrões'
      ,ro: 'Resetează și folosește setările implicite'
      }
    ,'Calibrations' : {   
      cs: 'Kalibrace'
      ,fr: 'Calibration'
      ,pr: 'Calibraçôes'
      ,ro: 'Calibrări'
      }
    ,'Alarm Test / Smartphone Enable' : {   
      cs: 'Test alarmu'
      ,fr: 'Test alarme'
      ,pr: 'Testar Alarme / Ativar Smartphone'
      ,ro: 'Teste alarme / Activează pe smartphone'
      }
    ,'Bolus Wizard' : {   
      cs: 'Bolusový kalkulátor'
      ,fr: 'Calculateur de bolus'
      ,pr: 'Bolus Wizard'
      ,ro: 'Calculator sugestie bolus'
      }
    ,'in the future' : {   
      cs: 'v budoucnosti'
      ,fr: 'dans le futur'
      ,pr: 'no futuro'
      ,ro: 'în viitor'
      }
    ,'time ago' : {   
      cs: 'min zpět'
      ,fr: 'temps avant'
      ,pr: 'tempo atrás'
      ,ro: 'în trecut'
      }
    ,'hr ago' : {   
      cs: 'hod zpět'
      ,fr: 'hr avant'
      ,pr: 'h atrás'
      ,ro: 'oră în trecut'
      }
    ,'hrs ago' : {   
      cs: 'hod zpět'
      ,fr: 'hrs avant'
      ,pr: 'h atrás'
      ,ro: 'h în trecut'
      }
    ,'min ago' : {   
      cs: 'min zpět'
      ,fr: 'min avant'
      ,pr: 'min atrás'
      ,ro: 'minut în trecut'
      }
    ,'mins ago' : {   
      cs: 'min zpět'
      ,fr: 'mins avant'
      ,pr: 'min atrás'
      ,ro: 'minute în trecut'
      }
    ,'day ago' : {   
      cs: 'den zpět'
      ,fr: 'jour avant'
      ,pr: 'dia atrás'
      ,ro: 'zi în trecut'
      }
    ,'days ago' : {   
      cs: 'dnů zpět'
      ,fr: 'jours avant'
      ,pr: 'dias atrás'
      ,ro: 'zile în trecut'
      }
    ,'long ago' : {   
      cs: 'dlouho zpět'
      ,fr: 'il y a très longtemps...'
      ,pr: 'muito tempo atrás'
      ,ro: 'timp în trecut'
      }
    ,'Clean' : {   
      cs: 'Čistý'
      ,fr: 'Propre'
      ,pr: 'Limpo'
      ,ro: 'Curat'
      }
    ,'Light' : {   
      cs: 'Lehký'
      ,fr: 'Léger'
      ,pr: 'Leve'
      ,ro: 'Ușor'
      }
    ,'Medium' : {   
      cs: 'Střední'
      ,fr: 'Moyen'
      ,pr: 'Médio'
      ,ro: 'Mediu'
      }
    ,'Heavy' : {   
      cs: 'Velký'
      ,fr: 'Important'
      ,pr: 'Pesado'
      ,ro: 'Puternic'
      }
    ,'Treatment type' : {   
      cs: 'Typ ošetření'
      ,fr: 'Type de traitement'
      ,pr: 'Tipo de tratamento'
      ,ro: 'Tip tratament'
      }
    ,'Raw BG' : {   
      cs: 'Glykémie z RAW dat'
      ,fr: 'BG brut'
      ,pr: 'Glicemia sem processamento'
      ,ro: 'Citire brută a glicemiei'
      }
    ,'Device' : {   
      cs: 'Zařízení'
      ,fr: 'Appareil'
      ,pr: 'Dispositivo'
      ,ro: 'Dispozitiv'
      }
    ,'Noise' : {   
      cs: 'Šum'
      ,fr: 'Bruit'
      ,pr: 'Ruído'
      ,ro: 'Zgomot'
      }
    ,'Calibration' : {   
      cs: 'Kalibrace'
      ,fr: 'Calibration'
      ,pr: 'Calibração'
      ,ro: 'Calibrare'
      }
    ,'Show Plugins' : {   
      cs: 'Zobrazuj pluginy'
      ,pr: 'Mostrar Plugins'
      ,ro: 'Arată plugin-urile'
      }
    ,'About' : {   
      cs: 'O aplikaci'
      ,pr: 'Sobre'
      ,ro: 'Despre'
      }
    ,'Value in' : {   
      cs: 'Hodnota v'
      ,pr: 'Valor em'
      ,ro: 'Valoare în'
      }
    ,'Prebolus' : {   
      cs: 'Posunuté jídlo'
      ,pr: 'Pré-bolus'
      ,ro: 'Prebolus'
      }
    ,'Carb Time' : {   
      cs: 'Čas jídla'
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
