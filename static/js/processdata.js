// Fetch info from site via API  
    	function getCustomJSON(URL, type, callback){
        	$.ajax({
            		url: URL,
            		method: 'GET',
            		dataType: 'json',
            		success: function(data){
				if(type == "profile") {
					currProfile = data[0].defaultProfile;
					// Define current basal 
					var basalProfile = data[0].store[currProfile].basal;  
					if(timeStr > basalProfile[Object.keys(basalProfile).length-1].time){
						currBasal = parseFloat(basalProfile[Object.keys(basalProfile).length-1].value);
					}
					 else{
						for (i = 1; i < Object.keys(basalProfile).length; i++){
							if (timeStr < basalProfile[i].time) {
								currBasal = parseFloat(basalProfile[i-1].value);
								break; 
							}
						}
					}
					// Define current sensitivity
					var sensProfile = data[0].store[currProfile].sens;  
					if(timeStr > sensProfile[Object.keys(sensProfile).length-1].time){
						currSens = parseFloat(sensProfile[Object.keys(sensProfile).length-1].value);
					}
					else{
						for (i = 1; i < Object.keys(sensProfile).length; i++){
							if (timeStr < sensProfile[i].time) {
								currSens = parseFloat(sensProfile[i-1].value);
								break; 
							}
						}
					}
					// Define current carb ratio
					var ratioProfile = data[0].store[currProfile].carbratio;  
					if(timeStr > ratioProfile[Object.keys(ratioProfile).length-1].time){
						currCarbRatio = parseFloat(ratioProfile[Object.keys(ratioProfile).length-1].value);
					}
					else{
						for (i = 1; i < Object.keys(ratioProfile).length; i++){
							if (timeStr < ratioProfile[i].time) {
								currCarbRatio = parseFloat(ratioProfile[i-1].value);
								break; 
							}
						}
					}
					// Define current low and high values 
					var lowProfile = data[0].store[currProfile].target_low;
					if(timeStr > lowProfile[Object.keys(lowProfile).length-1].time){
						lowerBGgoal = parseInt(lowProfile[Object.keys(lowProfile).length-1].value);
					}
					else{
						for (i = 1; i < Object.keys(lowProfile).length; i++){
							if (timeStr < lowProfile[i].time) {
								lowerBGgoal = parseInt(lowProfile[i-1].value);
								break; 
							}
						}
					}
					var highProfile = data[0].store[currProfile].target_high;
					if(timeStr > highProfile[Object.keys(highProfile).length-1].time){
						upperBGgoal = parseInt(highProfile[Object.keys(highProfile).length-1].value);
					}
					else{
						for (i = 1; i < Object.keys(highProfile).length; i++){
							if (timeStr < highProfile[i].time) {
								upperBGgoal = parseInt(highProfile[i-1].value);
								break; 
							}
						}
					} 
					
					activeInsulinHours = parseFloat(data[0].store[currProfile].dia);
					
					// Return values
					callback(currProfile,currBasal,currSens,currCarbRatio,lowerBGgoal,upperBGgoal,activeInsulinHours);
				}
               			if(type == "BG") {
					 // Define current BG
					 currBG = parseInt(data[0].sgv);
					 delta30mins = parseInt(data[0].sgv)-parseInt(data[5].sgv);
					 delta60mins = parseInt(data[0].sgv)-parseInt(data[11].sgv);
					 BGtrend = data[0].direction;
					 timestamp = data[0].dateString;
					 callback(currBG,delta30mins,delta60mins,BGtrend);
			       }
				if(type == "Treatments") {
					callback(data);
			       }
            		},
            		error: function(data){
            			document.getElementById("errors").innerHTML = "Derp derp derp.";
            		}
            	});    
      } // end getCustomJSON
      // Fetch nutrition info from MyFitnessPal page  
      function getMFPData(callback){
	      $.ajax({
		      url: MFPurl,
		      method: 'GET',
            	      dataType: 'html',
            	      crossOrigin: true,
		      success: function(data){
			      mfpCode = data;
			      callback(mfpCode);
            	      },
            	      error: function(data){
			      document.getElementById("errors").innerHTML += "MyFitnessPal data could not be pulled";
            	      }
         	}); 
      } // end getMFPData
// Crawl MyFitnessPal page data for meal nutritional info  
      function getMealData(mealName){
	      getMFPData(function(returnData){
		      var breakfastStart = mfpCode.indexOf('<tr class="meal_header">');
		      var lunchStart = mfpCode.indexOf('<tr class="meal_header">',breakfastStart+24); 
		      var dinnerStart = mfpCode.indexOf('<tr class="meal_header">',lunchStart+24); 
		      var aftSnackStart = mfpCode.indexOf('<tr class="meal_header">',dinnerStart+24); 
		      var mornSnackStart = mfpCode.indexOf('<tr class="meal_header">',aftSnackStart+24); 
		      var eveSnackStart = mfpCode.indexOf('<tr class="meal_header">',mornSnackStart+24); 
		      var end = mfpCode.indexOf('<tr class="spacer">',eveSnackStart+24);
		      if(mealName == "Breakfast"){ mealCode = mfpCode.substring(breakfastStart,lunchStart); }
		      else if(mealName == "Lunch"){ mealCode = mfpCode.substring(lunchStart,dinnerStart); }
		      else if(mealName == "Dinner"){ mealCode = mfpCode.substring(dinnerStart,aftSnackStart); }
		      else if(mealName == "Afternoon Snack"){ mealCode = mfpCode.substring(aftSnackStart,mornSnackStart); }
		      else if(mealName == "Morning Snack"){ mealCode = mfpCode.substring(mornSnackStart,eveSnackStart); }
		      else if(mealName == "Evening Snack"){ mealCode = mfpCode.substring(eveSnackStart,end); }
		      var totalsRef = mealCode.indexOf('class="quick_add_meals_list hidden">');
		      // Carbs
		      var carbsStart = mealCode.indexOf('<span class="macro-value">',totalsRef)+26;
		      var carbsEnd = mealCode.indexOf('</span>',carbsStart);
		      carbs = parseFloat(mealCode.substring(carbsStart,carbsEnd));
		      // Fat
		      var fatStart = mealCode.indexOf('<span class="macro-value">',carbsEnd)+26;
		      var fatEnd = mealCode.indexOf('</span>',fatStart);
		      fat = parseFloat(mealCode.substring(fatStart,fatEnd)); 
		      // Protein
		      var proteinStart = mealCode.indexOf('<span class="macro-value">',fatEnd)+26;
		      var proteinEnd = mealCode.indexOf('</span>',proteinStart);
		      protein = parseFloat(mealCode.substring(proteinStart,proteinEnd));
		      // Fiber
		      var fiberStart = mealCode.indexOf('<td>',proteinEnd)+4;
		      var fiberEnd = mealCode.indexOf('</td>',fiberStart);
		      fiber = parseFloat(mealCode.substring(fiberStart,fiberEnd));
		      // Check if meal data exists
		      if(isNaN(carbs) || isNaN(carbs) || isNaN(carbs) || isNaN(carbs)){
			      document.getElementById("results_meal").innerHTML = "<br/>No meal data available."; 
		      }
		      else{
			      document.getElementById("carbs").value = carbs; 
			      document.getElementById("fat").value = fat; 
			      document.getElementById("protein").value = protein;  
			      document.getElementById("fiber").value = fiber; 
			      bolusCalcWFood(mealName);
		      }	
              }); 
	} // end getMealData

function BGtrends(){
      	trendChar = '';
        trendText = '';
	var staleWarning = '';      
	// Get current date, compare to BG date
	var JStimestamp = new Date(timestamp);
	var diff = Math.abs(today-JStimestamp);
	var minutes = Math.floor((diff/1000)/60);    
	if(minutes >= 10) { staleWarning=" &#x2757 Data is "+minutes+" minutes old." }      
	var origBG = currBG;
      	if(BGtrend == "FortyFiveUp") { currBG += 15; trendChar='&#x2197';}
        if(BGtrend == "SingleUp") { currBG += 30; trendChar='&#x2B06';}
        if(BGtrend == "DoubleUp") { currBG += 50; trendChar='&#x23EB';}
        if(BGtrend == "FortyFiveDown") { currBG -= 15; trendChar='&#x2198';}
        if(BGtrend == "SingleDown") { currBG -= 30; trendChar='&#x2B07';}
        if(BGtrend == "DoubleDown") { currBG -= 50; trendChar='&#x23EC';}
        if(BGtrend == "Flat") {trendChar='&#x27A1';}
	var trendWarn30 = '';      
	var trendWarn60 = '';
	if(((origBG+delta30mins) < lowerBGgoal) || ((origBG+delta30mins) > upperBGgoal)){ trendWarn30 = " &#x2757&#x2757"; }  
	//if((delta30mins >= 30) || (delta30mins <= -30)){ trendWarn30 = " &#x2757&#x2757"; }  
	if(((origBG+delta60mins) < lowerBGgoal) || ((origBG+delta60mins) > upperBGgoal)){ trendWarn60 = " &#x2757"; }      
	//if((delta60mins >= 30) || (delta60mins <= -30)){ trendWarn60 = " &#x2757"; }
        trendText = "BG: "+origBG+staleWarning+"<br/>BG Trend: "+trendChar+"<br/>30 min delta: "+delta30mins+trendWarn30+"<br/>60 min delta: "+delta60mins+trendWarn60+"<br/>Time since last meal/snack: --<br/>IOB (food): --";
        document.getElementById("resultsBG").innerHTML = trendText;
      }
