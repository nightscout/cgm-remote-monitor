
function cleanSingleRecord(val) {
    // Remove the [] array brackets from single record collections (e.g. settings).
    val = JSON.stringify(val);
    val = val.substring(1, val.length-1);
    return JSON.parse(val.trim());
}




var utils = {
  cleanSingleRecord: cleanSingleRecord
};

module.exports = utils;

