// ~~~~~~~~~~~~~~~~~~~~~~~~~ INSTANTIATE VARIABLES ~~~~~~~~~~~~~~~~~~~~~~~~~

//Static
var BGgoal = 90;
var hostname = location.protocol + '//' + location.host;
var MFPurl = "http://www.myfitnesspal.com/food/diary/oboe_girl4";
var profileURL = hostname + "/api/v1/profile.json";
var entriesURL = hostname + "/api/v1/entries.json";
var treatmentsURL = hostname + "/api/v1/treatments.json";
var secret = "c96c4972f2f35a0b74e91b75dccf0d3807a16ad1";
var delta45 = 15;
var deltasingle = 30;
var deltadouble = 50;

//Dynamic

//Time
var today;
var hours = 0;
var minutes = 0;
var timeStr = '';
var UTCtimeStr = '';

//Stats	
var currBG = 0;
var delta30mins = 0;
var delta60mins = 0;
var BGtrend = "";
var currProfile = "";
var currBasal = 0.0;
var currSens = 0.0;
var currCarbRatio = 0.0;
var timestamp = '';
var upperBGgoal = 0;
var middleBGgoal = 0;
var lowerBGgoal = 0;
var treatmentsArray;
var activeInsulinHours = 0;
var IOBfood = 0;
var IOBcorr = 0;
var carbAbsorbRate = 0;
var COB = 0;

//Food	
var mfpCode = '';
var mealCode = '';
var carbs = 0;
var fat = 0;
var protein = 0;
var fiber = 0;
var netCarbs = 0;

//Dosing
var eventType = '';
var newBolus = 0;
var newBolusExt = 0;
var newBolusCorr = 0;
var newBolusSuper = 0;
var newBolusCarbs = 0;
var newBolusProtein = 0;
var newBolusFat = 0;
var additionalMessage = '';
var addCarbs = 0;
var trendChar = '';
var trendText = '';
var totalBolus = 0;
var percentNow = 0;
var percentExt = 0;
var prebolus = 0;
var basalnotes = '';
var exerciseSuggestion = '';
var exerciseType = '';
var exercisingSoon = 0;
var exerciseDuration = 0;
var timeTillNextExercise = 0;
var predictedBGdrop = 0;
var futureExerciseType = '';
var extBolusTime = 120;

// ~~~~~~~~~~~~~~~~~~~~~~~~~ DEFINE FUNCTIONS ~~~~~~~~~~~~~~~~~~~~~~~~~
// Set date/time
function getDate() {
    today = new Date(); // for now
    hours = today.getHours();
    if (hours < 10) { hours = "0" + hours; }
    minutes = today.getMinutes();
    if (minutes < 10) { minutes = "0" + minutes; }
    timeStr = hours + ":" + minutes;
    UTCtimeStr = today.toJSON();
} // end getDate

// Clear divs without resetting all variables      
function cleardivs(exception) {
    document.getElementById("submission_meal").innerHTML = "";
    if (exception != "Meal") {
        document.getElementById("results_meal").innerHTML = "";
        $("#results_mealdose").hide();
    }
    document.getElementById("submission_correction").innerHTML = "";
    //if(exception != "Correction") { document.getElementById("results_correction").innerHTML = ""; }
    document.getElementById("submission_tempbasal").innerHTML = "";
    if (exception != "Exercise") { document.getElementById("submission_exercise").innerHTML = ""; }
    document.getElementById("submission_removepump").innerHTML = "";
    document.getElementById("errors").innerHTML = "";
} // end cleardivs

// Refresh/reset all data and fields	  
function resetVars() {
    // Time
    getDate();
    //Stats

    exercisingSoon = 0;
    timeTillNextExercise = 0;
    exerciseDuration = 0;
    predictedBGdrop = 0;
    futureExerciseType = '';

    getCustomJSON(profileURL, "profile", function(returndata) {
        if (returndata == "Error pulling stats") {
            document.getElementById("errors").innerHTML = returndata + " - Profile";
        } else {
            getCustomJSON(entriesURL + "?count=12", "BG", function(returndata) {
                if (returndata != "Error pulling stats") {
                    trendText = BGtrends();
                    document.getElementById("resultsBG").innerHTML = trendText;
                    getCustomJSON(treatmentsURL, "Treatments", function(returndata) {
                        if (returndata != "Error pulling stats") {
                            treatmentsArray = returndata;
                            var treatmentString = processTreatments(treatmentsArray);
                            prevString = document.getElementById("resultsBG").innerHTML;
                            document.getElementById("resultsBG").innerHTML = prevString.substring(0, prevString.length - 2) + treatmentString;
                        } else {
                            document.getElementById("errors").innerHTML = returndata + " - Treatments";
                        }
                    });
                } else {
                    document.getElementById("errors").innerHTML = returndata + " - Entries";
                }
            });
        }
    });

    //Food
    mfpCode = '';
    mealCode = '';
    resetMealData();

    //Dosing
    eventType = '';
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
    prebolus = 0;
    basalnotes = '';
    exerciseSuggestion = '';
    exerciseType = '';
    extBolusTime = 120;
    //Clear form values if needed
    document.getElementById("basalduration").value = "";
    document.getElementById("basalpercent").value = "";
    //document.getElementById("corrCarbs").value = "";
    //document.getElementById("corrdose").value = "";
    //Clear all submission/result divs
    cleardivs("N/A");
    bolusCalc();
} // end resetVars   	

// Clear meal data values	
function resetMealData() {
    carbs = 0;
    fat = 0;
    protein = 0;
    fiber = 0;
    netCarbs = 0;
    document.getElementById("carbs").value = 0;
    document.getElementById("fat").value = 0;
    document.getElementById("protein").value = 0;
    document.getElementById("fiber").value = 0;
} // end resetMealData