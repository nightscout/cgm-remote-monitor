
var tz = require('moment-timezone');

function arrayHasElementWithSameTimestampAndProperty(array,t,propname) {
    for (var j=0; j < array.length; j++) {
        var element = array[j];
        if (element.timestamp == t && element[propname] != undefined) return true;
    }
    return false;
}

function findMealInputs (inputs) {
    var pumpHistory = inputs.history;
    var carbHistory = inputs.carbs;
    var profile_data = inputs.profile;
    var mealInputs = [];
    var duplicates = 0;
    
    for (var i=0; i < carbHistory.length; i++) {
        var current = carbHistory[i];
        if (current.carbs && current.created_at) {
            var temp = {};
            temp.timestamp = current.created_at;
            temp.carbs = current.carbs;
            
        if (!arrayHasElementWithSameTimestampAndProperty(mealInputs,current.created_at,"carbs")) {
                mealInputs.push(temp);
            } else {
                duplicates += 1;
            }
        }
    }
    for (var i=0; i < pumpHistory.length; i++) {
        var current = pumpHistory[i];
        if (current._type == "Bolus" && current.timestamp) {
            //console.log(pumpHistory[i]);
            var temp = {};
            temp.timestamp = current.timestamp;
            temp.bolus = current.amount;
            
            if (!arrayHasElementWithSameTimestampAndProperty(mealInputs,current.timestamp,"bolus")) {
                mealInputs.push(temp);
            } else {
                duplicates += 1;
            }
        } else if (current._type == "BolusWizard" && current.timestamp) {
            //console.log(pumpHistory[i]);
            var temp = {};
            temp.timestamp = current.timestamp;
            temp.carbs = current.carb_input;
            
            // don't enter the treatment if there's another treatment with the same exact timestamp
            // to prevent duped carb entries from multiple sources
            if (!arrayHasElementWithSameTimestampAndProperty(mealInputs,current.timestamp,"carbs")) {
                mealInputs.push(temp);
            } else {
                duplicates += 1;
            }
        } else if (current.enteredBy == "xdrip") {
            var temp = {};
            temp.timestamp = current.created_at;
            temp.carbs = current.carbs;
            temp.bolus = current.insulin;
            if (!arrayHasElementWithSameTimestampAndProperty(mealInputs,current.timestamp,"carbs")) {
                mealInputs.push(temp);
            } else {
                duplicates += 1;
            }
        } else if (current.carbs > 0) {
            var temp = {};
            temp.carbs = current.carbs;
            temp.timestamp = current.created_at;
            if (!arrayHasElementWithSameTimestampAndProperty(mealInputs,current.timestamp,"carbs")) {
                mealInputs.push(temp);
            } else {
                duplicates += 1;
            }
        }
    }
    
    if (duplicates > 0) console.error("Removed duplicate bolus/carb entries:" + duplicates);
    
    return mealInputs;
}

exports = module.exports = findMealInputs;
