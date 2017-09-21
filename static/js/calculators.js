// Calculate boluses involving food data
function bolusCalcWFood(mealName) {
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
    netCarbs = carbs - fiber;

    // Adjust correction sensitivity at various high BG thresholds

    var nullDataWarn = '';
    if (currBG === undefined) {
        currBG = 90;
        nullDataWarn = "<br/>&#x2757 Current BG is undefined.";
    }
    if (currBG > 250) {
        currSens = currSens * .833;
    } else if (currBG > 200) {
        currSens = currSens * .917;
    } else if (currBG > upperBGgoal) {
        newBolusSuper = currBasal; //Super bolus
        additionalMessage = "Super bolus, wait till bend.";
        if (protein > 20) {
            additionalMessage = "Super bolus, wait till bend if possible.";
        }
    } else if (currBG > middleBGgoal) {
        if ((netCarbs > 30) || (fat < 20)) {
            if ((prebolus < 10) && (fat < 20)) { //Super bolus
                newBolusSuper = currBasal;
                additionalMessage = "Super bolus, wait till bend if possible.";
            } else {
                additionalMessage = "Wait till bend if possible.";
            }
            if (prebolus > 10) {
                additionalMessage = "Wait till bend if possible.";
            }
        } else {
            if (prebolus < 10) {
                newBolusSuper = currBasal;
                additionalMessage = "Super bolus if eating immediately.";
            } //Super bolus
        }
    }

    // Calculate carb and correction base doses
    newBolusCorr = ((currBG - BGgoal) / currSens) - IOBcorr; //Correction
    if ((newBolusCorr > 0) && (predictedBGdrop > 0)) {
        newBolusCorr = newBolusCorr * .7;
    }
    if ((newBolusCorr < 0) && (currBG > 75)) { newBolusCorr = 0; }

    // ~~~~~~~~~~~~~~~~~~~ NEW ALGORITHM ~~~~~~~~~~~~~~~~~~~
    var reduceBolusNowBy = 0; // used only for complex meals?
    if (fiber > 10) {
        if (currBG < middleBGgoal) {
            reduceBolusNowBy = 0.2;
        }
    }
    console.log("Meal: " + mealName);
    var CU = (netCarbs / 10.0);
    console.log("CU: " + CU);
    var newProtein;
    if (netCarbs < 20) {
        newProtein = protein;
    } else {
        newProtein = protein - 20;
    }
    if (newProtein < 0) { newProtein = 0; }
    var newFat = (fat - 20);
    if (newFat < 0) { newFat = 0; }
    var origFPU = (protein * 4.0 + fat * 9.0) / 100.0;
    var FPU = (newProtein * 4.0 + newFat * 2) / 100.0;

    console.log("Original FPU: " + origFPU);
    console.log("Modified FPU: " + FPU);
    var IRFactor = (10.0 / currCarbRatio);
    console.log("Current profile: " + currProfile);
    console.log("Carb ratio: " + currCarbRatio);
    console.log("IRFactor: " + IRFactor);
    newBolusCarbs = CU * IRFactor * (1 - reduceBolusNowBy);
    console.log("Bolus now: " + newBolusCarbs);
    newBolusExt = FPU * IRFactor * (1 + reduceBolusNowBy);
    console.log("Extended bolus: " + newBolusExt);
    var timeReductionFactor = FPU / origFPU;
    if (origFPU < 1.0) { extBolusTime = 0; } else if ((origFPU >= 1.0) && (origFPU < 2.0)) { extBolusTime = 180 * timeReductionFactor; } // modified from recommended 180 minutes
    else if ((origFPU >= 2.0) && (origFPU < 3.0)) { extBolusTime = 240 * timeReductionFactor; } // modified from recommended 240 minutes
    else if ((origFPU >= 3.0) && (origFPU < 4.0)) { extBolusTime = 300 * timeReductionFactor; } // modified from recommended 300 minutes
    else { extBolusTime = 480 * timeReductionFactor; } // modified from recommended 480 minutes
    extBolusTime = Math.round(extBolusTime);
    console.log("Original extended bolus time: " + extBolusTime + " minutes");
    if (extBolusTime % 30 < 15) { extBolusTime -= extBolusTime % 30; } else { extBolusTime = extBolusTime - extBolusTime % 30 + 30; } // rounding up to half hours
    //console.log("Calculated extended bolus time: " + (extBolusTime / 60.0).toFixed(1) + " hours");
    // Refactor percentages for complex meals
    if (origFPU < 1.0) {
        newBolusCarbs = newBolusCarbs + newBolusExt;
        newBolusExt = 0;
        onsole.log("Refactored: Low protein, low fat");
    }
    if ((newFat == 0) && (newProtein > 0) && (netCarbs < 20)) {
        newBolusCarbs = newBolusCarbs + newBolusExt;
        newBolusExt = 0;
        console.log("Refactored: High protein, low fat, low carb");
    } else if ((newFat > 0) && (newProtein > 0) && (netCarbs < 20)) {
        newBolusCarbs = newBolusCarbs + newBolusExt * .2;
        newBolusExt = newBolusExt * .8;
        console.log("Refactored: High protein, high fat, low carb");
    }

    // ~~~~~~~~~~~~~~~~~~~ END NEW ALGORITHM ~~~~~~~~~~~~~~~~~~~
    var newBolusExtAdj = newBolusExt;
    if (predictedBGdrop > 0) {
        newBolusExtAdj -= .7 * (predictedBGdrop / currSens);
        newBolusCarbs -= .3 * (predictedBGdrop / currSens);
        newBolus = newBolusCarbs + newBolusSuper + newBolusCorr;
        if (newBolusExtAdj < 0) {
            newBolusCarbs += newBolusExtAdj;
        }
    } else {
        newBolus = newBolusCarbs + newBolusSuper + newBolusCorr;
        if (newBolus < 0) { // correction is greater than bolus now
            newBolus = newBolusCarbs + newBolusSuper;
            newBolusExtAdj = newBolusExtAdj + newBolusCorr;
        }
    }
    if (newBolus < 0) { newBolus = 0; }
    if (newBolusExtAdj < 0) {
        newBolusExt = 0;
        newBolusExtAdj = 0;
        extBolusTime = 0;
    }
    totalBolus = newBolus + newBolusExtAdj;
    if (totalBolus < 0) { totalBolus = 0; }
    percentExt = Math.round((newBolusExtAdj / totalBolus) * 100);
    percentNow = 100 - percentExt; //((newBolusExt/totalBolus)*100);
    // Accomodate upcoming exercise
    addCarbs = (75 - currBG) / (currSens / currCarbRatio) - carbs;
    if (predictedBGdrop > 0) {
        addCarbs += predictedBGdrop / (currSens / currCarbRatio);
    }
    //console.log("Add carbs: "+addCarbs);
    if (addCarbs >= 0.5) {
        document.getElementById("results_meal").innerHTML = "<br/>Need more carbs! Eat " + addCarbs.toFixed(0) + "g more. &#x1F36C" + nullDataWarn;
    }
    var extBolusText = '';
    var extBolusTimeText = (extBolusTime / 60.0).toFixed(1);
    if (newBolusExtAdj > 0) {
        extBolusText = " (" + percentNow.toFixed(0) + "% / " + percentExt.toFixed(0) + "%)<br/>" + newBolus.toFixed(2) + " + " + newBolusExtAdj.toFixed(2) + " extended over " + extBolusTimeText + " hour(s). ";
    } else {
        extBolusText = ". ";
        extBolusTime = "N/A";
    }
    if (predictedBGdrop > 0) {
        additionalMessage += " Adjusted by " + (predictedBGdrop / currSens).toFixed(2) + " units for upcoming exercise.";
    }

    document.getElementById("results_meal").innerHTML += "<br/>Recommended bolus: " +
        totalBolus.toFixed(2) + extBolusText + additionalMessage + nullDataWarn;
    $("#results_mealdose").show();
    document.getElementById("carbdose_meal").value = newBolusCarbs.toFixed(2);
    document.getElementById("extdose_meal").value = newBolusExtAdj.toFixed(2);
    document.getElementById("corrdose_meal").value = newBolusCorr.toFixed(2);
    document.getElementById("super_meal").value = newBolusSuper.toFixed(2);
    document.getElementById("bolusnow_meal").value = percentNow.toFixed(0);
    document.getElementById("bolusext_meal").value = percentExt.toFixed(0);
    document.getElementById("extBolusTime").value = extBolusTime;
} // end bolusCalcWFood

// Calculate boluses for corrections only
function bolusCalc() {
    newBolus = 0;
    newBolusCorr = 0;
    newBolusSuper = 0;
    additionalMessage = '';
    addCarbs = 0;
    var nullDataWarn = '';
    if (currBG === undefined) {
        currBG = 90;
        nullDataWarn = "<br/>&#x2757 Current BG is undefined.";
    }
    if (currBG > 250) {
        currSens = currSens * .833;
    } else if (currBG > 200) {
        currSens = currSens * .917;
    }
    newBolusCorr = ((currBG - BGgoal) / currSens) - IOBcorr; //Correction
    if ((newBolusCorr < 0) && (currBG > 75)) { newBolusCorr = 0; }
    if (currBG > upperBGgoal) {
        newBolusSuper = currBasal; //Correction + Super bolus
        additionalMessage = "Add super bolus."
    }
    newBolus = newBolusCorr + newBolusSuper;
    var divToWriteTo = 'results_correction';
    if (newBolus < 0) {
        addCarbs = (75 - currBG) / (currSens / currCarbRatio);
        if (predictedBGdrop > 0) {
            addCarbs += predictedBGdrop / (currSens / currCarbRatio);
        }
        if (addCarbs < 0) { addCarbs = 0; }
        if (addCarbs < 0.5) { document.getElementById(divToWriteTo).innerHTML = "<br/>No correction needed!" + nullDataWarn; } else { document.getElementById(divToWriteTo).innerHTML = "<br/>Need more carbs! Eat " + addCarbs.toFixed(0) + "g. &#x1F36C" + nullDataWarn; }
        document.getElementById("corrCarbs").value = addCarbs.toFixed(0);
        document.getElementById("corrdose").value = 0;
    } else if (newBolus < 0.1) {
        document.getElementById(divToWriteTo).innerHTML = "<br/>No correction needed!" + nullDataWarn;
        document.getElementById("corrCarbs").value = 0;
        document.getElementById("corrdose").value = 0;
    } else {
        document.getElementById("corrCarbs").value = 0;
        if (newBolusSuper == 0) {
            document.getElementById(divToWriteTo).innerHTML = "<br/>Recommended bolus: " + newBolus.toFixed(2) + ". " + additionalMessage + nullDataWarn;
        } else {
            document.getElementById(divToWriteTo).innerHTML = "<br/>Recommended bolus: " + newBolus.toFixed(2) + ". " + additionalMessage + "<br/>Correction: " + newBolusCorr.toFixed(2) + "<br/>Super: " + newBolusSuper.toFixed(2) + nullDataWarn;
        }

        document.getElementById("corrdose").value = newBolus.toFixed(2);
    }
} // bolusCalc

// Bolus calc handler
function calcFoodBolus(mealOrSnack, name) {
    resetVars();
    eventType = mealOrSnack + " Bolus";
    prebolus = document.getElementById("prebolus").value;
    getMealData(name, function(data) {
        if (data != "<br/>No meal data available.") {
            document.getElementById("carbs").value = carbs;
            document.getElementById("fat").value = fat;
            document.getElementById("protein").value = protein;
            document.getElementById("fiber").value = fiber;
            bolusCalcWFood(name);
        } else {
            document.getElementById("errors").innerHTML = "Couldn't get meal results";
        }
    });
} // end calcFoodBolus