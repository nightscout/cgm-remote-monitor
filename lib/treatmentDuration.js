'use strict';

const times = require('./times');

function hasOwnProperty (obj, field) {
  return obj && Object.prototype.hasOwnProperty.call(obj, field);
}

function toMills (value) {
  if (value === null || typeof value === 'undefined') {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string' && value.trim() === '') {
    return null;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }

  const dateMills = new Date(value).getTime();
  return Number.isFinite(dateMills) ? dateMills : null;
}

function resolveBaseMills (doc, fallbackDoc) {
  return toMills(doc && doc.mills)
    ?? toMills(fallbackDoc && fallbackDoc.mills)
    ?? toMills(doc && doc.created_at)
    ?? toMills(doc && doc.date)
    ?? toMills(fallbackDoc && fallbackDoc.created_at)
    ?? toMills(fallbackDoc && fallbackDoc.date);
}

function normalizeTreatmentDuration (doc, fallbackDoc) {
  const baseMills = resolveBaseMills(doc, fallbackDoc);

  if ((!hasOwnProperty(doc, 'endmills') || doc.endmills == null) && baseMills !== null) {
    if (hasOwnProperty(doc, 'durationInMilliseconds')) {
      const durationInMilliseconds = Number(doc.durationInMilliseconds) || 0;
      if (durationInMilliseconds > 0) {
        doc.endmills = baseMills + durationInMilliseconds;
      }
    } else if (hasOwnProperty(doc, 'duration')) {
      doc.endmills = baseMills + times.mins(Number(doc.duration) || 0).msecs;
    } else if (hasOwnProperty(fallbackDoc, 'durationInMilliseconds')) {
      const durationInMilliseconds = Number(fallbackDoc.durationInMilliseconds) || 0;
      if (durationInMilliseconds > 0) {
        doc.endmills = baseMills + durationInMilliseconds;
      }
    } else if (hasOwnProperty(fallbackDoc, 'duration')) {
      doc.endmills = baseMills + times.mins(Number(fallbackDoc.duration) || 0).msecs;
    }
  }

  const endMills = hasOwnProperty(doc, 'endmills') ? Number(doc.endmills) : NaN;
  if (Number.isFinite(baseMills) && Number.isFinite(endMills) && endMills >= baseMills) {
    doc.durationInMilliseconds = endMills - baseMills;
    doc.duration = Math.round(doc.durationInMilliseconds / 60000);
  }

  return doc;
}

module.exports = {
  normalizeTreatmentDuration,
  resolveBaseMills
};
