import dayjs from "dayjs";
import config from "./config";
import {
  BasalRecord,
  BolusRecord,
  CarbRecord,
  GlucoseRecord,
  PatientRecord,
  PatientRecordWithDeviceData,
  PumpSettings,
} from "./diasend";
import {
  CarbCorrectionTreatment,
  CorrectionBolusTreatment,
  ManualGlucoseValueEntry,
  MealBolusTreatment,
  Profile,
  ProfileConfig,
  SensorGlucoseValueEntry,
  TempBasalTreatment,
  TimeBasedValue,
} from "./nightscout";

export function diasendGlucoseRecordToNightscoutEntry(
  record: PatientRecordWithDeviceData<GlucoseRecord>
): SensorGlucoseValueEntry | ManualGlucoseValueEntry {
  // FIXME: The created_at datetimes from diasend do not contain any timezone information which can be problematic
  const date = new Date(record.created_at);

  const isManualBloodGlucose = record.flags.find(
    (f) => f.description === "Manual"
  );

  const shared = {
    dateString: date.toISOString(),
    date: date.getTime(),
    app: "diasend",
    device: `${record.device.model} (${record.device.serial})`,
  };

  if (isManualBloodGlucose) {
    return {
      type: "mbg",
      mbg: record.value,
      ...shared,
    };
  } else {
    return {
      type: "sgv",
      direction: undefined, // TODO: we currently cannot obtain the direction / trend from diasend
      sgv: record.value,
      ...shared,
    };
  }
}

// carbs should have been recorded within three minutes after / before a meal bolus
const diasendBolusCarbTimeDifferenceThresholdMilliseconds = 3 * 60 * 1000;
const nightscoutApp = "diasend";

function doCarbsBelongToBolus(carbRecord: CarbRecord, others: PatientRecord[]) {
  const bolusRecord = others
    .filter<BolusRecord>(
      (r): r is BolusRecord =>
        r.type === "insulin_bolus" && "programmed_meal" in r
    )
    .filter((bolusRecord) =>
      isRecordCreatedWithinTimeSpan(
        carbRecord,
        bolusRecord,
        diasendBolusCarbTimeDifferenceThresholdMilliseconds
      )
    )
    // there could be multiple bolus records within the timespan. We look at the closest one only
    .sort(
      (r1, r2) =>
        Math.abs(dayjs(r1.created_at).diff(carbRecord.created_at)) -
        Math.abs(dayjs(r2.created_at).diff(carbRecord.created_at))
    )
    // get first (= closest) bolus record
    .find(() => true);

  if (!bolusRecord) {
    return false;
  }

  // if there's another carb record between the carb record in question and the bolus, that one takes precedence
  const index = others.indexOf(carbRecord);
  const bolusRecordIndex = others.indexOf(bolusRecord);
  const lowerIndex = index > bolusRecordIndex ? bolusRecordIndex : index;
  const upperIndex = lowerIndex === bolusRecordIndex ? index : bolusRecordIndex;
  if (others.slice(lowerIndex + 1, upperIndex).some((v) => v.type === "carb")) {
    return false;
  }
  return true;
}

function isRecordCreatedWithinTimeSpan(
  r1: PatientRecord,
  r2: PatientRecord,
  timespanMilliseconds: number
) {
  return (
    Math.abs(dayjs(r1.created_at).diff(r2.created_at)) <= timespanMilliseconds
  );
}

type NonGlucoseRecords = BasalRecord | BolusRecord | CarbRecord;

// the default duration for temp basal events
// diasend doesn't provide any duration but we need it for nightscout
const defaultTempBasalDurationMinutes = 6 * 60;

export function diasendRecordToNightscoutTreatment(
  record: PatientRecordWithDeviceData<NonGlucoseRecords>,
  allRecords: PatientRecordWithDeviceData<NonGlucoseRecords>[]
):
  | MealBolusTreatment
  | CorrectionBolusTreatment
  | CarbCorrectionTreatment
  | TempBasalTreatment
  | undefined {
  const baseTreatmentData = {
    app: nightscoutApp,
    date: new Date(record.created_at).getTime(),
    device: `${record.device.model} (${record.device.serial})`,
    created_at: new Date(record.created_at).toISOString(),
  };

  // temp basal changes can be handled directly
  if (record.type === "insulin_basal") {
    return {
      eventType: "Temp Basal",
      absolute: record.value,
      duration: defaultTempBasalDurationMinutes,
      ...baseTreatmentData,
    };
  }

  // if there's a carb record, check if there's a preceeding or following (meal) bolus record
  if (record.type == "carb") {
    // if so, it's a meal / snack bolus and already handled
    if (doCarbsBelongToBolus(record, allRecords)) return undefined;
    // if not so, it's a hypoglycaemia treatment and we need to create a treatment for it
    return {
      eventType: "Carb Correction",
      carbs: parseInt(record.value),
      ...baseTreatmentData,
    };
  }

  const bolusRecord = record;
  // for a (meal) bolus, find the corresponding carbs record, if any
  // the carbs record is usually added within 1 minute prior or after the bolus for some reason
  // if it's not a meal bolus, it's a correction bolus
  const isMealBolus = "programmed_meal" in bolusRecord;
  if (isMealBolus) {
    const carbRecord = allRecords
      .filter<PatientRecordWithDeviceData<CarbRecord>>(
        (record): record is PatientRecordWithDeviceData<CarbRecord> =>
          record.type === "carb"
      )
      .filter(
        // carbs should have been recorded within the next minute after or before a bolus
        (carbRecord) =>
          isRecordCreatedWithinTimeSpan(
            carbRecord,
            bolusRecord,
            diasendBolusCarbTimeDifferenceThresholdMilliseconds
          )
      )
      // there could be multiple carb entries within the given timespan, we need to take the closest one
      .sort(
        (c1, c2) =>
          Math.abs(dayjs(c1.created_at).diff(bolusRecord.created_at)) -
          Math.abs(dayjs(c2.created_at).diff(bolusRecord.created_at))
      )
      // get first element or null
      .find(() => true);

    const notesParts = [];
    if (!carbRecord) {
      throw new Error("Could not find matching carb record. Please retry.");
    }

    if (bolusRecord.programmed_bg_correction) {
      notesParts.push(`Correction: ${bolusRecord.programmed_bg_correction}`);
    }

    return {
      eventType: "Meal Bolus",
      insulin: bolusRecord.total_value,
      carbs: !carbRecord ? undefined : parseInt(carbRecord.value),
      notes: notesParts.length ? notesParts.join(", ") : undefined,
      ...baseTreatmentData,
      date: new Date(bolusRecord.created_at).getTime(),
      created_at: new Date(bolusRecord.created_at).toISOString(),
    };
  } else {
    if (bolusRecord.programmed_bg_correction) {
      return {
        eventType: "Correction Bolus",
        insulin: bolusRecord.total_value,
        ...baseTreatmentData,
        date: new Date(bolusRecord.created_at).getTime(),
        created_at: new Date(bolusRecord.created_at).toISOString(),
      };
    } else {
      console.warn("Bolus record cannot be handled", bolusRecord);
      return;
    }
  }
}

function convertToTimeBasedValue([startTime, value]: [
  string,
  number
]): TimeBasedValue {
  const [hours, minutes, ..._] = startTime.split(":");
  return {
    value,
    time: [hours, minutes].join(":"),
    timeAsSeconds: parseInt(hours) * 3600 + parseInt(minutes) * 60,
  };
}

export function diasendPumpSettingsToNightscoutProfile(
  pumpSettings: PumpSettings
): ProfileConfig {
  return {
    sens: pumpSettings.insulinSensitivityProfile.map(convertToTimeBasedValue),
    basal: pumpSettings.basalProfile.map(convertToTimeBasedValue),
    carbratio: pumpSettings.insulinCarbRatioProfile.map(
      convertToTimeBasedValue
    ),
    target_high: pumpSettings.bloodGlucoseTargetHigh
      ? [
          {
            time: "00:00",
            value: pumpSettings.bloodGlucoseTargetHigh,
            timeAsSeconds: 0,
          },
        ]
      : [],
    target_low: pumpSettings.bloodGlucoseTargetLow
      ? [
          {
            time: "00:00",
            value: pumpSettings.bloodGlucoseTargetLow,
            timeAsSeconds: 0,
          },
        ]
      : [],
    ...(pumpSettings.insulinOnBoardDurationHours
      ? { dia: pumpSettings.insulinOnBoardDurationHours }
      : {}),
    units: pumpSettings.units,
    timezone: process.env.TZ,
  };
}

export function convertBasalRecord(basalRecord: BasalRecord): TimeBasedValue {
  const recordTime = dayjs(basalRecord.created_at);
  const recordTimeAsSeconds = recordTime.diff(
    recordTime.startOf("day"),
    "seconds"
  );
  return {
    time: recordTime.format(recordTime.get("seconds") ? "HH:mm:ss" : "HH:mm"),
    timeAsSeconds: recordTimeAsSeconds,
    value: basalRecord.value,
  };
}

export function updateNightScoutProfileWithPumpSettings(
  existingProfile: Profile,
  pumpSettings: PumpSettings,
  options: {
    importBasalRate: boolean;
    nightscoutProfileName: string;
  } = {
    importBasalRate: true,
    nightscoutProfileName: config.nightscout.profileName!,
  }
): Profile {
  const pumpSettingsAsProfileConfig =
    diasendPumpSettingsToNightscoutProfile(pumpSettings);

  const previousProfileConfig =
    existingProfile.store[options.nightscoutProfileName] ?? {};

  return {
    ...existingProfile,
    store: {
      ...(existingProfile.store ?? {}),
      [options.nightscoutProfileName]: {
        ...previousProfileConfig,
        basal: options.importBasalRate
          ? pumpSettingsAsProfileConfig.basal
          : previousProfileConfig.basal,
      },
    },
  };
}
