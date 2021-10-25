const storage = require('js-storage').localStorage;
const COOKIE_KEY = 'reportProperties';
const defaultValues = {
    insulin: true,
    carbs: true,
    basal: true,
    notes: false,
    food: false,
    raw: false,
    iob: true,
    cob: true,
    predicted: false,
    openAps: false,
    insulindistribution: true,
    predictedTruncate: true,
    bgcheck: false,
    othertreatments: true
};
let cachedProps;

const saveProps = function (props) {
    let propsToSave = {};
    for (const prop in props) {
        if (!Object.prototype.hasOwnProperty.call(defaultValues, prop))
            continue;
        propsToSave[prop] = props[prop];
    }
    storage.set(COOKIE_KEY, propsToSave);
};

const getValue = function (p) {
    if (!cachedProps)
        cachedProps = storage.get(COOKIE_KEY) || defaultValues;
    return cachedProps[p];
};

module.exports = {saveProps: saveProps, getValue: getValue};
