import { identifyTreatments } from "../index";
import { diasendRecordToNightscoutTreatment } from "../adapter";
import {
  BasalRecord,
  BolusRecord,
  CarbRecord,
  DeviceData,
  PatientRecord,
  PatientRecordWithDeviceData,
} from "../diasend";
import {
  CarbCorrectionTreatment,
  CorrectionBolusTreatment,
  MealBolusTreatment,
  TempBasalTreatment,
} from "../nightscout";

const testDevice: DeviceData = {
  manufacturer: "ACME",
  serial: "1111-22123",
  model: "Test Pump",
};

describe("testing conversion of diasend patient data to nightscout treatments", () => {
  test("meal bolus + carbs", () => {
    // given a meal bolus and matching carb record
    const mealBolusRecord: PatientRecordWithDeviceData<BolusRecord> = {
      type: "insulin_bolus",
      created_at: "2022-08-26T18:20:27",
      unit: "U",
      total_value: 0.7,
      spike_value: 0.7,
      suggested: 0.7,
      suggestion_overridden: "no",
      suggestion_based_on_bg: "no",
      suggestion_based_on_carb: "yes",
      programmed_meal: 0.7,
      flags: [
        {
          flag: 1035,
          description: "Bolus type ezcarb",
        },
      ],
      device: testDevice,
    };
    const carbRecord: PatientRecordWithDeviceData<CarbRecord> = {
      type: "carb",
      created_at: "2022-08-26T18:21:05",
      value: "18",
      unit: "g",
      flags: [],
      device: testDevice,
    };

    // when converting the reading to a nightscout entry
    const nightscoutTreatment = diasendRecordToNightscoutTreatment(
      mealBolusRecord,
      [mealBolusRecord, carbRecord]
    );

    // then expect it to look like this
    expect(nightscoutTreatment).toStrictEqual<MealBolusTreatment>({
      date: 1661530827000,
      created_at: new Date(1661530827000).toISOString(),
      carbs: 18,
      eventType: "Meal Bolus",
      insulin: 0.7,
      device: "Test Pump (1111-22123)",
      app: "diasend",
      notes: undefined,
    });
  });

  test("meal bolus with correction", () => {
    // given a correction bolus with a meal bolus and matching carbs
    const bolusRecord: PatientRecordWithDeviceData<BolusRecord> = {
      type: "insulin_bolus",
      created_at: "2022-08-25T11:28:55",
      unit: "U",
      total_value: 0.3,
      spike_value: 0.3,
      suggested: 0.3,
      suggestion_overridden: "no",
      suggestion_based_on_bg: "yes",
      suggestion_based_on_carb: "yes",
      programmed_meal: 0.4,
      programmed_bg_correction: -0.1,
      flags: [
        {
          flag: 1034,
          description: "Bolus type ezbg",
        },
        {
          flag: 1035,
          description: "Bolus type ezcarb",
        },
      ],
      device: testDevice,
    };
    const carbRecord: PatientRecordWithDeviceData<CarbRecord> = {
      type: "carb",
      created_at: "2022-08-25T11:29:31",
      value: "11",
      unit: "g",
      flags: [],
      device: testDevice,
    };

    // when converting the reading to a nightscout entry
    const nightscoutTreatment = diasendRecordToNightscoutTreatment(
      bolusRecord,
      [bolusRecord, carbRecord]
    );

    // then expect it to look like this
    expect(nightscoutTreatment).toStrictEqual<MealBolusTreatment>({
      date: 1661419735000,
      created_at: new Date(1661419735000).toISOString(),
      carbs: 11,
      eventType: "Meal Bolus",
      insulin: 0.3,
      device: "Test Pump (1111-22123)",
      app: "diasend",
      notes: "Correction: -0.1",
    });
  });

  test("meal bolus without maching carbs", () => {
    // given a meal bolus without matching carbs
    const bolusRecord: PatientRecordWithDeviceData<BolusRecord> = {
      type: "insulin_bolus",
      created_at: "2022-08-25T11:28:55",
      unit: "U",
      total_value: 0.3,
      spike_value: 0.3,
      suggested: 0.3,
      suggestion_overridden: "no",
      suggestion_based_on_bg: "yes",
      suggestion_based_on_carb: "yes",
      programmed_meal: 0.4,
      programmed_bg_correction: -0.1,
      flags: [
        {
          flag: 1034,
          description: "Bolus type ezbg",
        },
        {
          flag: 1035,
          description: "Bolus type ezcarb",
        },
      ],
      device: testDevice,
    };

    // when converting the reading to a nightscout entry
    expect(() => diasendRecordToNightscoutTreatment(bolusRecord, [bolusRecord]))
      // then expect to get an exception
      .toThrowError("Could not find matching carb record");
  });

  test("correction bolus", () => {
    // given a correction-only bolus
    const bolusRecord: PatientRecordWithDeviceData<BolusRecord> = {
      type: "insulin_bolus",
      created_at: "2022-08-25T15:42:11",
      unit: "U",
      total_value: 0.2,
      spike_value: 0.2,
      suggested: 0.2,
      suggestion_overridden: "no",
      suggestion_based_on_bg: "yes",
      suggestion_based_on_carb: "no",
      programmed_bg_correction: 0.2,
      flags: [
        {
          flag: 1034,
          description: "Bolus type ezbg",
        },
      ],
      device: testDevice,
    };

    // when converting the reading to a nightscout entry
    const nightscoutTreatment = diasendRecordToNightscoutTreatment(
      bolusRecord,
      [bolusRecord]
    );

    // then expect it to look like this
    expect(nightscoutTreatment).toStrictEqual<CorrectionBolusTreatment>({
      date: 1661434931000,
      created_at: new Date(1661434931000).toISOString(),
      eventType: "Correction Bolus",
      insulin: 0.2,
      device: "Test Pump (1111-22123)",
      app: "diasend",
    });
  });

  test("convert hypoglycaemia treatment", () => {
    // given a hypoglycaemia treatment (which is essentially: Just carbs without any bolus)
    const records: PatientRecordWithDeviceData<CarbRecord>[] = [
      {
        type: "carb",
        created_at: "2022-09-18T13:50:40",
        value: "5",
        unit: "g",
        flags: [],
        device: testDevice,
      },
    ];

    // When passing through the converter
    const treatment = diasendRecordToNightscoutTreatment(records[0], records);

    // Then expect to obtain a hypo treatment
    expect(treatment).toStrictEqual<CarbCorrectionTreatment>({
      date: 1663501840000,
      created_at: new Date(1663501840000).toISOString(),
      eventType: "Carb Correction",
      carbs: 5,
      device: "Test Pump (1111-22123)",
      app: "diasend",
    });
  });

  test("detect hypoglycaemia treatment with confusing meal bolus", () => {
    // given a hypoglycaemia treatment (which is essentially: Just carbs without any bolus)
    const records: PatientRecordWithDeviceData<PatientRecord>[] = [
      {
        type: "glucose",
        created_at: "2022-09-18T13:49:30",
        value: 61,
        unit: "mg/dl",
        flags: [
          {
            flag: 123,
            description: "Continous reading",
          },
        ],
        device: testDevice,
      },
      {
        type: "carb",
        created_at: "2022-09-18T13:50:40",
        value: "7",
        unit: "g",
        flags: [],
        device: testDevice,
      },
      {
        type: "glucose",
        created_at: "2022-09-18T13:54:29",
        value: 56,
        unit: "mg/dl",
        flags: [
          {
            flag: 123,
            description: "Continous reading",
          },
        ],
        device: testDevice,
      },
      // want to have a bolus here as well to ensure it's not mixed up with the hypo
      {
        type: "insulin_bolus",
        created_at: "2022-09-18T14:08:38",
        unit: "U",
        total_value: 0.5,
        spike_value: 0.5,
        suggested: 0.5,
        suggestion_overridden: "no",
        suggestion_based_on_bg: "no",
        suggestion_based_on_carb: "yes",
        programmed_meal: 0.5,
        flags: [
          {
            flag: 1035,
            description: "Bolus type ezcarb",
          },
        ],
        device: testDevice,
      },
      {
        type: "carb",
        created_at: "2022-09-18T14:09:11",
        value: "11",
        unit: "g",
        flags: [],
        device: testDevice,
      },
    ];

    // When passing through the converter
    const { treatments, unprocessedRecords } = identifyTreatments(records);

    // Then expect to obtain a potential carb correction (postponed to next run) and a meal bolus
    expect(treatments).toHaveLength(1);
    expect(unprocessedRecords).toHaveLength(1);
    expect(unprocessedRecords[0].type).toBe("carb");
    expect(treatments[0].eventType).toBe("Meal Bolus");
    expect((treatments[0] as MealBolusTreatment).carbs).toBe(11);
    expect((treatments[0] as MealBolusTreatment).insulin).toBe(0.5);
  });

  test("remembers bolus records without matching carbs for next run", () => {
    // Given a bunch of records that contain a bolus for a programmed meal but miss the corresponding carbs
    const records: PatientRecordWithDeviceData<PatientRecord>[] = [
      {
        type: "glucose",
        created_at: "2022-09-18T13:54:29",
        value: 56,
        unit: "mg/dl",
        flags: [
          {
            flag: 123,
            description: "Continous reading",
          },
        ],
        device: testDevice,
      },
      {
        type: "insulin_bolus",
        created_at: "2022-09-18T14:08:38",
        unit: "U",
        total_value: 0.5,
        spike_value: 0.5,
        suggested: 0.5,
        suggestion_overridden: "no",
        suggestion_based_on_bg: "no",
        suggestion_based_on_carb: "yes",
        programmed_meal: 0.5,
        flags: [
          {
            flag: 1035,
            description: "Bolus type ezcarb",
          },
        ],
        device: testDevice,
      },
    ];

    // When attempting to identify the treatments
    const { unprocessedRecords } = identifyTreatments(records);

    // Then expect the bolus record to stay unprocessed
    expect(unprocessedRecords).toHaveLength(1);
    expect((unprocessedRecords[0] as BolusRecord).programmed_meal).toBe(0.5);
  });

  test("identifies meal bolus if carb record coming after bolus", () => {
    // Given a meal bolus where the insulin_bolus event comes prior to the matching carbs
    const records: PatientRecordWithDeviceData<PatientRecord>[] = [
      {
        type: "carb",
        created_at: "2022-11-05T13:28:55",
        value: "3",
        unit: "g",
        flags: [],
        device: testDevice,
      },
      {
        type: "insulin_bolus",
        created_at: "2022-11-05T13:28:58",
        unit: "U",
        total_value: 0.1,
        spike_value: 0.1,
        suggested: 0.1,
        suggestion_overridden: "no",
        suggestion_based_on_bg: "no",
        suggestion_based_on_carb: "yes",
        programmed_meal: 0.1,
        flags: [
          {
            flag: 1035,
            description: "Bolus type ezcarb",
          },
        ],
        device: testDevice,
      },
    ];

    // When identifying the treatments
    const { treatments, unprocessedRecords } = identifyTreatments(records);

    // Then expect to get the bolus with matching carbs
    expect(unprocessedRecords).toHaveLength(0);
    expect(treatments).toHaveLength(1);

    expect((treatments[0] as MealBolusTreatment).carbs).toBe(3);
    expect((treatments[0] as MealBolusTreatment).insulin).toBe(0.1);
  });

  test("takes closest carb record for meal bolus", () => {
    // Given a meal bolus where the insulin_bolus event comes prior to the matching carbs and there's a preceeding carb correction
    const records: PatientRecordWithDeviceData<PatientRecord>[] = [
      {
        type: "carb",
        created_at: "2022-11-05T13:28:00",
        value: "10",
        unit: "g",
        flags: [],
        device: testDevice,
      },
      {
        type: "carb",
        created_at: "2022-11-05T13:28:55",
        value: "5",
        unit: "g",
        flags: [],
        device: testDevice,
      },
      {
        type: "insulin_bolus",
        created_at: "2022-11-05T13:28:58",
        unit: "U",
        total_value: 0.1,
        spike_value: 0.1,
        suggested: 0.1,
        suggestion_overridden: "no",
        suggestion_based_on_bg: "no",
        suggestion_based_on_carb: "yes",
        programmed_meal: 0.1,
        flags: [
          {
            flag: 1035,
            description: "Bolus type ezcarb",
          },
        ],
        device: testDevice,
      },
    ];

    // When identifying the treatments
    const { treatments, unprocessedRecords } = identifyTreatments(records);

    // Then expect to get the bolus with matching carbs and a postponsed carb record (will be a carb correction in next run)
    expect(treatments).toHaveLength(1);

    expect(unprocessedRecords[0].type).toBe("carb");
    expect((treatments[0] as MealBolusTreatment).carbs).toBe(5);
    expect((treatments[0] as MealBolusTreatment).insulin).toBe(0.1);
  });

  test("postpones processing of carb record if no matching bolus", () => {
    // Given a carb record without a matching bolus (in the currently processed set of records)
    const records: PatientRecordWithDeviceData<PatientRecord>[] = [
      {
        type: "carb",
        created_at: "2022-11-05T13:28:00",
        value: "10",
        unit: "g",
        flags: [],
        device: testDevice,
      },
    ];

    // When attempting to identify treatments
    const { unprocessedRecords } = identifyTreatments(records);

    // The carb record is kept as a unprocessed record for the next run
    expect(unprocessedRecords).toHaveLength(1);
  });

  test("imports insulin basal records as temp basal treatments", () => {
    // Given a basal record
    const records: PatientRecordWithDeviceData<BasalRecord>[] = [
      {
        type: "insulin_basal",
        created_at: "2022-11-05T13:28:00",
        value: 0.5,
        unit: "U/h",
        flags: [],
        device: testDevice,
      },
    ];

    // When attempting to identify treatments
    const { treatments } = identifyTreatments(records);

    // The basal record is transformed to a temp basal treatment
    expect(treatments).toHaveLength(1);
    const tempBasalTreatment: TempBasalTreatment =
      treatments[0] as TempBasalTreatment;
    expect(tempBasalTreatment.absolute).toBe(0.5);
    // default duration should be 360 minutes (as otherwise nightscout will ignore the event)
    expect(tempBasalTreatment.duration).toBe(360);
    expect(tempBasalTreatment.date).toBe(
      new Date("2022-11-05T13:28:00").getTime()
    );
    expect(tempBasalTreatment.created_at).toBe(
      new Date("2022-11-05T13:28:00").toISOString()
    );
  });

  test("uses total value of correction bolus", () => {
    // Given a correction bolus
    const correctionBolusRecord: PatientRecordWithDeviceData = {
      type: "insulin_bolus",
      created_at: "2023-01-03T22:26:56",
      unit: "U",
      total_value: 0.5,
      spike_value: 0.5,
      suggested: 0,
      suggestion_overridden: "yes",
      suggestion_based_on_bg: "yes",
      suggestion_based_on_carb: "no",
      programmed_bg_correction: 0.001,
      flags: [
        {
          flag: 1034,
          description: "Bolus type ezbg",
        },
      ],
      device: testDevice,
    };

    // When attempting to convert it to a treatment
    const treatment = diasendRecordToNightscoutTreatment(
      correctionBolusRecord,
      [correctionBolusRecord]
    );

    // Then expect the insulin to match the record's total value
    expect((treatment as CorrectionBolusTreatment).insulin).toBe(0.5);
  });
});
