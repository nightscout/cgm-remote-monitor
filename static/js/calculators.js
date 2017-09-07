// Calculate boluses involving food data
function bolusCalcWFood(mealName){
	// Clear old data 
	newBolus = 0;
	newBolusExt = 0;
	newBolusCorr = 0;
	newBolusSuper = 0;
	newBolusCarbs = 0;
	newBolusProtein = 0;
	newBolusFat = 0;
	additionalMessage = '';
	addCarbs = 0;
	totalBolus = 0;
	percentNow = 0;
	percentExt = 0;
	netCarbs = 0;
	
	// Calculate net carbs
	if(mealName == "Breakfast"){ 
		netCarbs = carbs - (fiber / 2); 
	}
	else{
		netCarbs = carbs-fiber;
	}
	// Calculate carb and correction base doses
	// Adjust correction sensitivity at various high BG thresholds

	var nullDataWarn = '';
	if(currBG === undefined){
		currBG = 90;
		nullDataWarn = "<br/>&#x2757 Current BG is undefined.";
	}
	if(currBG>250){ 
		currSens = currSens*.75;
	}
	else if(currBG>200){ 
		currSens = currSens*.833;
	}
	else if(currBG>upperBGgoal){ 
		currSens = currSens*.917;
	}
	newBolusCorr = ((currBG-BGgoal)/currSens)-IOBcorr; //Correction
	newBolusCarbs = netCarbs/currCarbRatio; //Carbs
	if((netCarbs > 30) && (mealName != "Breakfast")){
		newBolusProtein = (protein/2)/10.0; //Protein
	}
	else{
		newBolusProtein = ((protein-20)/2)/10.0; //Protein
	}
	if(newBolusProtein<0) { newBolusProtein = 0; }
	      
        if(currBG>upperBGgoal){  
          	newBolusSuper = currBasal; //Super bolus
          	additionalMessage = "Super bolus, wait till bend.";
          	if(protein>20){ 
            		additionalMessage = "Super bolus, wait till bend if possible.";
          	}
        }
        else if(currBG>middleBGgoal){
          	if((netCarbs>30) || (fat<20)){
			if((prebolus < 10) && (fat<20)){ //Super bolus 
				newBolusSuper = currBasal; 
				additionalMessage = "Super bolus, wait till bend if possible.";		       
			} 
			else{
				additionalMessage = "Wait till bend if possible.";
			}
			if(prebolus>10){
				additionalMessage = "Wait till bend if possible.";
			}
          	}
          	else{
		  	if(prebolus < 10){  
				newBolusSuper = currBasal;	
				additionalMessage = "Super bolus if eating immediately.";
			} //Super bolus 
          	}
        }
        else if(currBG>lowerBGgoal){
          	if(netCarbs>30){
          		if(prebolus < 10){  
				newBolusSuper = currBasal;	
				additionalMessage = "Super bolus if eating immediately.";
			} //Super bolus 	
          	}
        }
	if((fat>20) || (fiber>10)){
        	//newBolusFat = (((fat-20)/2)/currCarbRatio); //Fat
		if(netCarbs < 30){
			newBolusFat = (newBolusCarbs*.2)+(fat*0.01);
			newBolusCarbs = newBolusCarbs*.8;
			extBolusTime = 120;
		}
		else{
			newBolusFat = (newBolusCarbs*.1)+(fat*0.01);
			newBolusCarbs = newBolusCarbs*.9;
			extBolusTime = 90;
		}
        }
	console.log("Meal: "+mealName);
	console.log("Carbs grams/dose: "+netCarbs+" / "+newBolusCarbs);
	console.log("Protein grams/dose: "+protein+" / "+newBolusProtein);
	if(mealName == "Breakfast"){
		newBolusCarbs = newBolusCarbs+newBolusProtein;
		newBolus = newBolusCorr+newBolusSuper+newBolusCarbs;
		newBolusExt = newBolusFat;
	}
	else{	
        	newBolus = newBolusCorr+newBolusSuper+newBolusCarbs;
		newBolusExt = newBolusFat+newBolusProtein;
	}
        totalBolus = newBolus + newBolusExt;
        percentNow = Math.round((newBolus/totalBolus)*100);
        percentExt = 100-percentNow; ((newBolusExt/totalBolus)*100);
        if(newBolus<0){
        	addCarbs = (BGgoal-currBG)/(currSens/currCarbRatio);
          	document.getElementById("results_meal").innerHTML = "<br/>Need more carbs! Eat "+addCarbs.toFixed(0)+"g. &#x1F36C"+nullDataWarn;
        }
        else{	
	  	var extBolusText = '';
		var extBolusTimeText = (extBolusTime/60.0).toFixed(1);
	  	if(newBolusExt > 0){
		  	extBolusText = " ("+percentNow.toFixed(0)+"% / "+percentExt.toFixed(0)+"%)<br/>"+newBolus.toFixed(2)+" + "+newBolusExt.toFixed(2)+" extended over "+extBolusTimeText+" hour(s). ";
	  	}
	  	else{ extBolusText = ". "; extBolusTime = "N/A"; }	

          	document.getElementById("results_meal").innerHTML = "<br/>Recommended bolus: "
			+ totalBolus.toFixed(2)+ extBolusText + additionalMessage + nullDataWarn;
		$("#results_mealdose").show();
		document.getElementById("carbdose_meal").value = newBolusCarbs.toFixed(2);
		document.getElementById("extdose_meal").value = newBolusExt.toFixed(2);
		document.getElementById("corrdose_meal").value = newBolusCorr.toFixed(2);
		document.getElementById("super_meal").value = newBolusSuper.toFixed(2);
		document.getElementById("bolusnow_meal").value = percentNow.toFixed(0);
		document.getElementById("bolusext_meal").value = percentExt.toFixed(0);	
        }
	document.getElementById("extBolusTime").value = extBolusTime;
} // end bolusCalcWFood
   
// Calculate boluses for corrections only
function bolusCalc(){
      	newBolus = 0;
      	newBolusCorr = 0;
      	newBolusSuper = 0;
      	additionalMessage = '';
        addCarbs = 0;
	var nullDataWarn = '';
	if(currBG === undefined){
		currBG = 90;
		nullDataWarn = "<br/>&#x2757 Current BG is undefined.";
	}
	if(currBG>250){ 
		currSens = currSens*.75;
	}
	else if(currBG>200){ 
		currSens = currSens*.833;
	}
	else if(currBG>upperBGgoal){ 
		currSens = currSens*.917;
	}
	newBolusCorr = ((currBG-BGgoal)/currSens)-IOBcorr; //Correction
        if(currBG>upperBGgoal){
          	newBolusSuper = currBasal; //Correction + Super bolus
          	additionalMessage = "Add super bolus."
        }
        newBolus = newBolusCorr + newBolusSuper;
	var divToWriteTo = 'results_correction';  
        if(newBolus<0){
        	addCarbs = (BGgoal-currBG)/(currSens/currCarbRatio);
		if(addCarbs < 0.5) { document.getElementById(divToWriteTo).innerHTML = "<br/>No carbs needed!"; }
		else { document.getElementById(divToWriteTo).innerHTML = "<br/>Need more carbs! Eat "+addCarbs.toFixed(0)+"g. &#x1F36C"+nullDataWarn; }
		document.getElementById("corrCarbs").value = addCarbs.toFixed(0); 
		document.getElementById("corrdose").value = 0;
        }
        else if (newBolus==0){
	  	document.getElementById(divToWriteTo).innerHTML = "<br/>No treatment needed!"+nullDataWarn; 
		document.getElementById("corrCarbs").value = 0; 	
          	document.getElementById("corrdose").value = 0;
        }
        else{ 
	  	document.getElementById("corrCarbs").value = 0;
		document.getElementById(divToWriteTo).innerHTML = "<br/>Recommended bolus: "+newBolus.toFixed(2)+". "+ additionalMessage +"<br/>Correction: "+newBolusCorr.toFixed(2)+"<br/>Super: "+newBolusSuper.toFixed(2)+nullDataWarn;
	  	document.getElementById("corrdose").value = newBolus.toFixed(2); 	 
        }
} // bolusCalc
    
// Bolus calc handler
function calcFoodBolus(mealOrSnack, name){
	resetVars(); 
	eventType = mealOrSnack+" Bolus"; 
	prebolus = document.getElementById("prebolus").value;
	getMealData(name, function(data){
		if (data != "<br/>No meal data available."){
		      	document.getElementById("carbs").value = carbs; 
		      	document.getElementById("fat").value = fat; 
		      	document.getElementById("protein").value = protein;  
		      	document.getElementById("fiber").value = fiber; 
		      	bolusCalcWFood(name);
	      	}
	      	else{
		    	document.getElementById("errors").innerHTML = "Couldn't get meal results";  
	      	}   
	});      
} // end calcFoodBolus
