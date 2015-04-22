
	var translations = {
		'Mo' : {
			cs: 'Po',
			de: 'Mo'
			},
		'Tu' : {
			cs: 'Út',
			de: 'Di'
			},
		'We' : {
			cs: 'St',
			de: 'Mi'
			},
		'Th' : {
			cs: 'Čt',
			de: 'Di'
			},
		'Fr' : {
			cs: 'Pá',
			de: 'Fr'
			},
		'Sa' : {
			cs: 'So',
			de: 'Sa'
			},
		'Su' : {
			cs: 'Ne',
			de: 'So'
			},
		'Monday' : {
			cs: 'Pondělí'
			},
		'Tuesday' : {
			cs: 'Úterý'
			},
		'Wednesday' : {
			cs: 'Středa'
			},
		'Thursday' : {
			cs: 'Čtvrtek'
			},
		'Friday' : {
			cs: 'Pátek'
			},
		'Saturday' : {
			cs: 'Sobota'
			},
		'Sunday' : {
			cs: 'Neděle'
			},
		'Category' : {
			cs: 'Kategorie'
			},
		'Subcategory' : { 	
			cs: 'Podkategorie'
			},
		'Name' : { 	
			cs: 'Jméno'
			},
		'Today' : { 	
			cs: 'Dnes'
			},
		'Last 2 days' : { 	
			cs: 'Poslední 2 dny'
			},
		'Last 3 days' : { 	
			cs: 'Poslední 3 dny'
			},
		'Last week' : { 	
			cs: 'Poslední týden'
			},
		'Last 2 weeks' : { 	
			cs: 'Poslední 2 týdny'
			},
		'Last month' : { 	
			cs: 'Poslední měsíc'
			},
		'Last 3 months' : { 	
			cs: 'Poslední 3 měsíce'
			},
		'From' : { 	
			cs: 'Od'
			},
		'To' : { 	
			cs: 'Do'
			},
		'Notes' : { 	
			cs: 'Poznámky'
			},
		'Food' : { 	
			cs: 'Jídlo'
			},
		'Insulin' : { 	
			cs: 'Inzulín'
			},
		'Carbs' : { 	
			cs: 'Sacharidy'
			},
		'Notes' : { 	
			cs: 'Poznámky'
			},
		'Notes contain' : { 	
			cs: 'Poznámky obsahují'
			},
		'Event type contain' : { 	
			cs: 'Typ události obsahuje'
			},
		'Target bg range bottom' : { 	
			cs: 'Cílová glykémie spodní'
			},
		'top' : { 	
			cs: 'horní'
			},
		'Show' : { 	
			cs: 'Zobraz'
			},
		'Display' : { 	
			cs: 'Zobraz'
			},
		'Loading profile' : { 	
			cs: 'Nahrávám profil'
			},
		'Loading status' : { 	
			cs: 'Nahrávám status'
			},
		'Loading food database' : { 	
			cs: 'Nahrávám databázi jídel'
			},
		'not displayed' : { 	
			cs: 'není zobrazeno'
			},
		'Loading CGM data of' : { 	
			cs: 'Nahrávám CGM data'
			},
		'Loading treatments data of' : { 	
			cs: 'Nahrávám data ošetření'
			},
		'Processing data of' : { 	
			cs: 'Zpracovávám data'
			},
		'Portion' : { 	
			cs: 'Porce'
			},
		'Size' : { 	
			cs: 'Rozměr'
			},
		'(none)' : { 	
			cs: '(Prázdný)'
			},
		'Result is empty' : { 	
			cs: 'Prázdný výsledek'
			}

	}
	
	
	function translate(text) {
		if (translations[text] && translations[text][serverSettings.defaults.language])
			return translations[text][serverSettings.defaults.language];
		return text;
	}
		
	// do translation of static text on load
	$('.translate').each(function (s) {
		//console.log($(this).text());
		$(this).text(translate($(this).text()));
	});