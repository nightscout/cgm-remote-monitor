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
	extBolusTime = 120;
	// Calculate net carbs
	if(mealName == "Breakfast"){ 
		netCarbs = carbs - (fiber / 2); 
	}
	else{
		netCarbs = carbs-fiber;
	}
	// Calculate carb and correction base doses
	newBolusCorr = (currBG-BGgoal)/currSens; //Correction
	newBolusCarbs = netCarbs/currCarbRatio; //Carbs
	      
        if(currBG>upperBGgoal){  
          	newBolusSuper = currBasal; //Super bolus
          	additionalMessage = "Super bolus, wait till bend.";
          	if((netCarbs<=20) && (protein>20)){ 
            		newBolusProtein = ((protein-20)/2)/currCarbRatio; //Protein
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
          	if((netCarbs<=20) && (protein>20)){ 
            		newBolusProtein = ((protein-20)/2)/currCarbRatio; //Protein
          	}
        }
        else if(currBG>lowerBGgoal){
          	if(netCarbs>30){
          		if(prebolus < 10){  
				newBolusSuper = currBasal;	
				additionalMessage = "Super bolus if eating immediately.";
			} //Super bolus 	
          	}
          	if((netCarbs<=20) && (protein>20)){ 
            		newBolusProtein = ((protein-20)/2)/currCarbRatio; //Protein
          	}
        }
        else{
        	if((netCarbs<=20) && (protein>20)){ 
           		newBolusProtein = ((protein-20)/2)/currCarbRatio; //Protein
          	}
        }
	if(fat>20){
        	//newBolusFat = (((fat-20)/2)/currCarbRatio); //Fat
	      	newBolusFat = newBolusCarbs*.2;
	      	newBolusCarbs = newBolusCarbs*.8;
        }
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
          	document.getElementById("results_meal").innerHTML = "<br/>Need more carbs! Eat "+addCarbs.toFixed(0)+"g. &#x1F36C";
        }
        else{	
	  	var extBolusText = '';
	  	if(newBolusExt > 0){
		  	extBolusText = " ("+percentNow.toFixed(0)+"% / "+percentExt.toFixed(0)+"%)<br/>"+newBolus.toFixed(2)+" + "+newBolusExt.toFixed(2)+" extended over 2 hours. ";
	  	}
	  	else{ extBolusText = ". "; extBolusTime = "N/A"; }	

          	document.getElementById("results_meal").innerHTML = "<br/>Recommended bolus: "
			+ totalBolus.toFixed(2)+ extBolusText + additionalMessage;
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
        if(currBG>upperBGgoal){
          	newBolusCorr = (currBG-BGgoal)/currSens;
          	newBolusSuper = currBasal; //Correction + Super bolus
          	additionalMessage = "Add super bolus."
        }
        else if(currBG>middleBGgoal){
          	newBolusCorr = (currBG-BGgoal)/currSens; //Correction
        }
        else if(currBG>lowerBGgoal){
          	newBolusCorr = (currBG-BGgoal)/currSens; //Correction, maybe UP
        }
        else{
          	newBolusCorr = (currBG-BGgoal)/currSens; //Correction UP
        }
        newBolus = newBolusCorr + newBolusSuper;
	var divToWriteTo = '';
	if(eventType == "Carb Correction") { divToWriteTo = 'results_carbs'; }
	if(eventType == "Correction Bolus") { divToWriteTo = 'results_correction'; }      
        if(newBolus<0){
        	addCarbs = (BGgoal-currBG)/(currSens/currCarbRatio);
		document.getElementById(divToWriteTo).innerHTML = "<br/>Need more carbs! Eat "+addCarbs.toFixed(0)+"g. &#x1F36C";
		document.getElementById("corrCarbs").value = addCarbs.toFixed(0); 	
        }
        else if (newBolus==0){
	  	if(eventType == "Carb Correction") { document.getElementById(divToWriteTo).innerHTML = "<br/>No carbs needed!"; }	
          	if(eventType == "Correction Bolus") { document.getElementById(divToWriteTo).innerHTML = "<br/>No insulin needed!"; }
        }
        else{ 
	  	if(eventType == "Carb Correction") { document.getElementById(divToWriteTo).innerHTML = "<br/>No carbs needed!"; }
	  	if(eventType == "Correction Bolus") { 
			document.getElementById(divToWriteTo).innerHTML = "<br/>Recommended bolus: "+newBolus.toFixed(2)+". "+ additionalMessage +"<br/>Correction: "+newBolusCorr.toFixed(2)+"<br/>Super: "+newBolusSuper.toFixed(2);
	  		document.getElementById("corrdose").value = newBolus.toFixed(2); 
	  	}   	 
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
