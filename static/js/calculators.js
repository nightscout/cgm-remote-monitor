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
	/*if(mealName == "Breakfast"){ 
		netCarbs = carbs - (fiber / 2); 
	}
	else{*/
		netCarbs = carbs-fiber;
	//}
	
	// Adjust correction sensitivity at various high BG thresholds

	var nullDataWarn = '';
	if(currBG === undefined){
		currBG = 90;
		nullDataWarn = "<br/>&#x2757 Current BG is undefined.";
	}
	if(currBG>250){ 
		currSens = currSens*.833;
	}
	else if(currBG>200){ 
		currSens = currSens*.917;
	}      
        else if(currBG>upperBGgoal){  
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
        /*else if(currBG>lowerBGgoal){
          	if(netCarbs>30){
          		if(prebolus < 10){  
				newBolusSuper = currBasal;	
				additionalMessage = "Super bolus if eating immediately.";
			} //Super bolus 	
          	}
        }*/
	// Calculate carb and correction base doses
	newBolusCorr = ((currBG-BGgoal)/currSens)-IOBcorr; //Correction

	// ~~~ OLD ALGORITHM ~~~
	//newBolusCarbs = netCarbs/currCarbRatio; //Carbs
	/*if((netCarbs > 30) && (mealName != "Breakfast")){
		newBolusProtein = (protein/2)/10.0; //Protein
	}
	else{*/
		/*newBolusProtein = ((protein-15)/2.0)/currCarbRatio; //Protein
	//}
	if(newBolusCarbs<0) { newBolusCarbs = 0; }
	if(newBolusProtein<0) { newBolusProtein = 0; }*/
	/*if((fat>20) || (fiber>10)){
        	//newBolusFat = (((fat-20)/2)/currCarbRatio); //Fat
		if(currBG < middleBGgoal){
			newBolusFat = (newBolusCarbs*.25);//+(fat*0.01);
			newBolusCarbs = newBolusCarbs*.75;
			extBolusTime = 120;
		}
		else{
			newBolusFat = (newBolusCarbs*.1);//+(fat*0.01);
			newBolusCarbs = newBolusCarbs*.9;
			extBolusTime = 90;
		}
        }
	console.log("Meal: "+mealName);
	console.log("Carbs grams/dose: "+netCarbs+" / "+newBolusCarbs);
	console.log("Protein grams/dose: "+protein+" / "+newBolusProtein);
	console.log("Fat grams/dose: "+fat+" / "+newBolusFat);
	if(mealName == "Breakfast"){
		newBolusCarbs = newBolusCarbs+newBolusProtein;
		newBolus = newBolusCorr+newBolusSuper+newBolusCarbs;
		newBolusExt = newBolusFat;
	}
	else{	
        	newBolus = newBolusCorr+newBolusSuper+newBolusCarbs;
		newBolusExt = newBolusFat+newBolusProtein;
	}*/
	// ~~~ END OLD ALGORITHM ~~~
	
	// ~~~~~~~~~~~~~~~~~~~ NEW ALGORITHM ~~~~~~~~~~~~~~~~~~~
	console.log("Meal: "+mealName);
	var CU = (netCarbs/10.0);
        console.log("CU: "+ CU);
        var FPU = (protein*4.0+fat*9.0)/100.0;
        console.log("FPU: "+ FPU);
        var IRFactor = (10.0/currCarbRatio);
        console.log("IRFactor: "+ IRFactor);
        var CDI = (CU + FPU) * IRFactor;
        console.log("CDI: "+ CDI);
        var CU_perc = CU / (CU + FPU);
        console.log("CU_perc: "+ CU_perc);
        console.log("Correction: "+ newBolusCorr);
        if (CU_perc < 0.2) { newBolus = 0; }
        else if (CU_perc >= 0.2 && CU_perc <= 0.8) { newBolus = CU * IRFactor * (1 - newBolusCorr); }
        else { newBolus = CU * IRFactor; }
        console.log("Bolus now: "+ newBolus);
        if ((FPU < 1.0) || ((FPU >= 1.0) && (CU_perc > 0.8))) { newBolusExt = 0; }
        else if ((FPU >= 1.0) && (CU_perc < 0.2)) { newBolusExt = FPU * IRFactor; }
        else if ((FPU >= 1.0) && (CU_perc >= 0.2) && (CU_perc <= 0.8) ) { newBolusExt = FPU * IRFactor * (1 - newBolusCorr); }
        console.log("Extended bolus: "+ newBolusExt);
        if ((FPU < 1.0) || (CU_perc > 0.8)) { extBolusTime = 0; }
        else if ((FPU >= 1.0) && (FPU < 2.0)) { extBolusTime = 180; }
        else if ((FPU >= 2.0) && (FPU < 3.0)) { extBolusTime = 240; }
        else if ((FPU >= 3.0) && (FPU < 4.0)) { extBolusTime = 300; }
        else { extBolusTime = 480; }
	console.log("Extended bolus time: "+ (extBolusTime/60.0).toFixed(1) +" hours");
	// ***Refactor percentages for meals with certain content, esp breakfast
	if(mealName == "Breakfast"){
		newBolus = newBolus + newBolusCorr + newBolusSuper + newBolusExt*0.7;
		newBolusExt = newBolusExt*0.3;
	}
	else{
		newBolus = newBolus + newBolusCorr + newBolusSuper;
	}
	// ~~~~~~~~~~~~~~~~~~~ END NEW ALGORITHM ~~~~~~~~~~~~~~~~~~~
	
	if(newBolus < 0) { newBolus = 0; }
	if(newBolusExt < 0) { newBolusExt = 0; extBolusTime = 0;}
	totalBolus = newBolus + newBolusExt;
	if(totalBolus < 0) { totalBolus = 0; }
        percentExt = Math.round((newBolusExt/totalBolus)*100);
        percentNow = 100-percentExt; //((newBolusExt/totalBolus)*100);
	addCarbs = (75-currBG)/(currSens/currCarbRatio)-carbs;
	if(addCarbs >= 0.5){
        	document.getElementById("results_meal").innerHTML = "<br/>Need more carbs! Eat "+addCarbs.toFixed(0)+"g more. &#x1F36C"+nullDataWarn;
	}	
	var extBolusText = '';
	var extBolusTimeText = (extBolusTime/60.0).toFixed(1);
	if(newBolusExt > 0){
		extBolusText = " ("+percentNow.toFixed(0)+"% / "+percentExt.toFixed(0)+"%)<br/>"+newBolus.toFixed(2)+" + "+newBolusExt.toFixed(2)+" extended over "+extBolusTimeText+" hour(s). ";
	}
	else{ extBolusText = ". "; extBolusTime = "N/A"; }	

        document.getElementById("results_meal").innerHTML += "<br/>Recommended bolus: "
		+ totalBolus.toFixed(2)+ extBolusText + additionalMessage + nullDataWarn;
	$("#results_mealdose").show();
	document.getElementById("carbdose_meal").value = newBolus.toFixed(2);
	document.getElementById("extdose_meal").value = newBolusExt.toFixed(2);
	document.getElementById("corrdose_meal").value = newBolusCorr.toFixed(2);
	document.getElementById("super_meal").value = newBolusSuper.toFixed(2);
	document.getElementById("bolusnow_meal").value = percentNow.toFixed(0);
	document.getElementById("bolusext_meal").value = percentExt.toFixed(0);	
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
		currSens = currSens*.833;
	}
	else if(currBG>200){ 
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
        	addCarbs = (75-currBG)/(currSens/currCarbRatio);
		if(addCarbs < 0){ addCarbs = 0; }
		if(addCarbs < 0.5) { document.getElementById(divToWriteTo).innerHTML = "<br/>No correction needed!"+nullDataWarn; }
		else { document.getElementById(divToWriteTo).innerHTML = "<br/>Need more carbs! Eat "+addCarbs.toFixed(0)+"g. &#x1F36C"+nullDataWarn; }
		document.getElementById("corrCarbs").value = addCarbs.toFixed(0); 
		document.getElementById("corrdose").value = 0;
        }
        else if (newBolus<0.1){
	  	document.getElementById(divToWriteTo).innerHTML = "<br/>No correction needed!"+nullDataWarn; 
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
