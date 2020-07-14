var _ = require('lodash');

const DATA_FIELDS = {
    "sgv": "sgv",
}

function roundDecimal(input, digits) {
    return Math.round(input * Math.pow(10, digits)) / Math.pow(10, digits);
}

export function processData(ingestedData, sortedDays) {
    const fieldTypes = ['cal', 'combobolusTreatments', 'devicestatus', 'mbg', 'sgv', 'statsrecords', 'tempbasalTreatments', 'treatments']
    let columns = ['type']
    let data = []
    for (let day of sortedDays) {
        data = data.concat(_.sortBy(_.flattenDeep(fieldTypes.map((field) => {
            columns = _.union(columns, _.keys(ingestedData[day][field][0] || {}))
            return (ingestedData[day][field] || []).map((val) => {
                val.type = field;
                return val;
            })
        })), (d) => d.date.getTime()))
    }
    return {
        columns,
        data: data.map((i) => {
            return Object.assign({}, i,
                i[DATA_FIELDS.sgv] !== undefined ? {
                    "BG mg/dL": i[DATA_FIELDS.sgv],
                    "BG mmol/L": roundDecimal(i[DATA_FIELDS.sgv] / 18.018, 1),
                } : {},
            );
        })
    }
}
