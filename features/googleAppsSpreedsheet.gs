var RECURRING_KEY = "recurring";
var ARGUMENTS_KEY = "arguments";
var NIGHTSCOUT_URL_API = "https://<NIGHTSCOUT_URL_API>/api/v1/entries.json?count=1";
var SHEETNAME = "<SHEETNAME>";

/**
* Sets up the arguments for the given trigger.
*
* @param {Trigger} trigger - The trigger for which the arguments are set up
* @param {*} raw - The arguments which should be stored for the function call
* @param {boolean} recurring - Whether the trigger is recurring; if not the
*   arguments and the trigger are removed once it called the function
*/
function setupTriggerArguments(trigger, raw, recurring) {
  var triggerUid = trigger.getUniqueId();
  var triggerData = {};
  triggerData[RECURRING_KEY] = recurring;
  triggerData[ARGUMENTS_KEY] = raw;

  PropertiesService.getScriptProperties().setProperty(triggerUid, JSON.stringify(triggerData));
}

/**
* Function which should be called when a trigger runs a function. Returns the stored arguments
* and deletes the properties entry and trigger if it is not recurring.
*
* @param {string} triggerUid - The trigger id
* @return {*} - The arguments stored for this trigger
*/
function getRawForTrigger(triggerUid) {
  var scriptProperties = PropertiesService.getScriptProperties();
  var triggerData = JSON.parse(scriptProperties.getProperty(triggerUid));

  if (!triggerData[RECURRING_KEY]) {
    deleteTriggerByUid(triggerUid);
  }

  return triggerData[ARGUMENTS_KEY];
}

/**
* Deletes trigger arguments of the trigger with the given id.
*
* @param {string} triggerUid - The trigger id
*/
function deleteTriggerArguments(triggerUid) {
  PropertiesService.getScriptProperties().deleteProperty(triggerUid);
}

/**
* Deletes a trigger with the given id and its arguments.
* When no project trigger with the id was found only an error is
* logged and the function continues trying to delete the arguments.
*
* @param {string} triggerUid - The trigger id
*/
function deleteTriggerByUid(triggerUid) {
  if (!ScriptApp.getProjectTriggers().some(function (trigger) {
    if (trigger.getUniqueId() === triggerUid) {
      ScriptApp.deleteTrigger(trigger);
      return true;
    }

    return false;
  })) {
    console.error("Could not find trigger with id '%s'", triggerUid);
  }

  deleteTriggerArguments(triggerUid);
}

/**
* Deletes a trigger and its arguments.
*
* @param {Trigger} trigger - The trigger
*/
function deleteTrigger(trigger) {
  ScriptApp.deleteTrigger(trigger);
  deleteTriggerArguments(trigger.getUniqueId());
}

/**
 * Fetches the latest glucose data from Nightscout.
 *
 * @return {Object} - An object containing the glucose value and trend
 */
function fetchNightscoutData() {
    try {
      var response = UrlFetchApp.fetch(NIGHTSCOUT_URL_API);
      var data = JSON.parse(response.getContentText());
      if (data.length > 0) {
        var glucose_mg_dl = data[0].sgv; // Glucose value in mg/dL
        var glucose_mmol_L = glucose_mg_dl * 0.05551; // Convert to mmol/L
        var direction = data[0].direction;
        return {glucose: glucose_mmol_L, trend: direction};
      }
    } catch (e) {
        Logger.log("Error fetching Nightscout data: " + e.toString());
    }
}

/**
 * Maps the trend string to a symbol.
 *
 * @param {string} trend - The trend string
 * @return {string} - The corresponding symbol
 */
function mapTrendToSymbol(trend) {
  switch (trend) {
      case "DoubleUp":
          return "↑↑";
      case "SingleUp":
          return "↑";
      case "FortyFiveUp":
          return "↗";
      case "Flat":
          return "→";
      case "FortyFiveDown":
          return "↘";
      case "SingleDown":
          return "↓";
      case "DoubleDown":
          return "↓↓";
      case "NOT COMPUTABLE":
          return "?";
      default:
          return "";
  }
}

/**
 * Fetches the latest glucose data from Nightscout and updates the spreadsheet.
 * This function is triggered by a time-based trigger.
 *
 * @param {Object} event - The event object containing trigger information
 */
function fetchFutureNightscoutData(event) {
  var raw = getRawForTrigger(event.triggerUid);
  Logger.log("Function arguments: %s", raw);
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETNAME);

  nightscoutData = fetchNightscoutData()
  glucose = nightscoutData.glucose
  trend = nightscoutData.trend
  trendSymbol = mapTrendToSymbol(trend);
  var sugarColumn = 9;
  var trendColumn = 10;
  sheet.getRange(raw, sugarColumn)
      .setValue(glucose);
  sheet.getRange(raw, trendColumn)
      .setValue(trendSymbol);
}

/**
 * Schedules a future fetch of Nightscout data.
 * This function is called when the user enters data in the spreadsheet.
 *
 * @param {number} raw - The row number where the data was entered
 */
function scheduleFutureFetch(raw) {
  var trigger = ScriptApp.newTrigger("fetchFutureNightscoutData").timeBased()
    .after(60 * 1000)
    .create();

  setupTriggerArguments(trigger, raw, false);
}

/**
 * Handles the onEdit event for the spreadsheet.
 * This function is triggered when the user edits the spreadsheet.
 * You should set up an installable trigger for this function.
 *
 * @param {Object} e - The event object containing information about the edit
 */
function installableOnEdit(e) {
    var sheet = e.source.getActiveSheet();
    var cell = e.range;
    if (sheet.getName() !== SHEETNAME) return; // Ignore other sheets


    // Define the column where timestamps should be inserted
    var timestampColumn1 = 1;
    var timestampColumn2 = 2;
    var sugarColumn = 3;
    var inputColumn = 4; // The column where user enters data

    if (cell.getColumn() == inputColumn && cell.getValue() != "") {
        sheet.getRange(cell.getRow(), timestampColumn1)
            .setValue(new Date());
        sheet.getRange(cell.getRow(), timestampColumn2)
            .setValue(new Date());
        nightscoutData = fetchNightscoutData();
        glucose = nightscoutData.glucose
        sheet.getRange(cell.getRow(), sugarColumn)
            .setValue(glucose);

        scheduleFutureFetch(cell.getRow());
    }
}
