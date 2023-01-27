import config from "./config";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import {
  obtainDiasendAccessToken,
  getPatientData,
  GlucoseRecord,
  CarbRecord,
  BolusRecord,
  getPumpSettings,
  getAuthenticatedScrapingClient,
  BasalRecord,
  PatientRecord,
  PatientRecordWithDeviceData,
} from "./diasend";
import {
  reportEntriesToNightscout,
  MealBolusTreatment,
  reportTreatmentsToNightscout,
  Treatment,
  CorrectionBolusTreatment,
  Entry,
  Profile,
  fetchProfile,
  updateProfile,
  CarbCorrectionTreatment,
  TempBasalTreatment,
} from "./nightscout";
import {
  diasendRecordToNightscoutTreatment,
  diasendGlucoseRecordToNightscoutEntry,
  updateNightScoutProfileWithPumpSettings,
} from "./adapter";
import { Looper } from "./Looper";

dayjs.extend(relativeTime);

interface BaseSyncDiasendArgs {
  diasendUsername?: string;
  diasendPassword?: string;
  diasendClientId?: string;
  diasendClientSecret?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

interface SyncDiasendGlucoseToNightscoutArgs extends BaseSyncDiasendArgs {
  nightscoutEntriesHandler?: (entries: Entry[]) => Promise<Entry[]>;
}

interface SyncDiasendDataToNightScoutArgs extends BaseSyncDiasendArgs {
  nightscoutProfileName?: string;
  nightscoutTreatmentsHandler?: (
    treatments: Treatment[]
  ) => Promise<Treatment[]>;
  previousRecords?: PatientRecordWithDeviceData<PatientRecord>[];
}

type NightscoutProfileOptions = {
  nightscoutProfileName?: string;
  nightscoutProfileLoader?: () => Promise<Profile>;
  nightscoutProfileHandler?: (profile: Profile) => Promise<Profile>;
};

type PostponedPatientRecordWithDeviceData<T extends PatientRecord> =
  PatientRecordWithDeviceData<T> & { postponed?: boolean };

export function identifyTreatments(
  records: PatientRecordWithDeviceData<PatientRecord>[]
) {
  type SupportedRecordType = PostponedPatientRecordWithDeviceData<
    CarbRecord | BolusRecord | BasalRecord
  >;

  const unprocessedRecords: SupportedRecordType[] = [];
  const treatments = records
    .filter<SupportedRecordType>((record): record is SupportedRecordType =>
      ["insulin_bolus", "carb", "insulin_basal"].includes(record.type)
    )
    .reduce<
      (
        | MealBolusTreatment
        | CorrectionBolusTreatment
        | CarbCorrectionTreatment
        | TempBasalTreatment
      )[]
    >((treatments, record, _index, allRecords) => {
      try {
        const treatment = diasendRecordToNightscoutTreatment(
          record,
          allRecords
        );

        if (treatment) {
          // if the detected treatment is a carb correction, we need to distinguish whether this is the first time we're processing this
          // due to the looping nature, the algorithm may deem the carb record to be a carb correction when it is actually just belonging
          // to a bolus which is not yet available within the list of records
          if (treatment?.eventType === "Carb Correction" && !record.postponed) {
            unprocessedRecords.push({ ...record, postponed: true });
          } else {
            treatments.push(treatment);
          }
        }
      } catch (e) {
        // if an error happened, this means we'll need to remember the record and try to resolve it in the next run
        unprocessedRecords.push(record);
      }

      return treatments;
    }, []);

  return { treatments, unprocessedRecords };
}

async function syncDiasendGlucoseToNightscout({
  diasendUsername = config.diasend.username,
  diasendPassword = config.diasend.password,
  diasendClientId = config.diasend.clientId,
  diasendClientSecret = config.diasend.clientSecret,
  nightscoutEntriesHandler = (entries) => reportEntriesToNightscout(entries),
  dateFrom = dayjs().subtract(10, "minutes").toDate(),
  dateTo = new Date(),
}: SyncDiasendGlucoseToNightscoutArgs) {
  const records = await getDiasendPatientData({
    diasendUsername,
    diasendPassword,
    diasendClientId,
    diasendClientSecret,
    dateFrom,
    dateTo,
  });

  // we only care about glucose values, ignore everything else
  const nightscoutEntries: Entry[] = records
    // TODO: support non-glucose type values
    // TODO: treat calibration events differently?
    .filter<PatientRecordWithDeviceData<GlucoseRecord>>(
      (record): record is PatientRecordWithDeviceData<GlucoseRecord> =>
        record.type === "glucose"
    )
    .map<Entry>((record) => diasendGlucoseRecordToNightscoutEntry(record));

  console.log(
    `Number of glucose records since ${dayjs(dateFrom).from(
      dateTo
    )} (${dateFrom.toISOString()} - ${dateTo.toISOString()}): `,
    nightscoutEntries.length
  );

  // send them to nightscout
  console.log(`Sending ${nightscoutEntries.length} entries to nightscout`);
  const entries = await nightscoutEntriesHandler(nightscoutEntries);
  return {
    entries,
    latestRecordDate:
      entries.length > 0
        ? new Date(
            // get latest record's date
            entries.sort((a, b) => dayjs(b.date).diff(a.date))[0].date
          )
        : null,
  };
}

async function syncDiasendDataToNightscout({
  diasendUsername = config.diasend.username,
  diasendPassword = config.diasend.password,
  diasendClientId = config.diasend.clientId,
  diasendClientSecret = config.diasend.clientSecret,
  nightscoutTreatmentsHandler = (treatments) =>
    reportTreatmentsToNightscout(treatments),
  dateTo = new Date(),
  dateFrom = dayjs(dateTo).subtract(10, "minutes").toDate(),
  previousRecords = [],
}: SyncDiasendDataToNightScoutArgs) {
  const records = (
    await getDiasendPatientData({
      diasendUsername,
      diasendPassword,
      diasendClientId,
      diasendClientSecret,
      dateFrom,
      dateTo,
    })
  )
    // filter out glucose records as they're handled independently
    .filter((r) => r.type !== "glucose");

  // calculate the latest record date
  // this has to be done before re-adding the previously postponed records
  const latestRecordDate =
    records.length > 0
      ? new Date(
          records
            // sort records by date (descending)
            .sort((r1, r2) =>
              dayjs(r2.created_at).diff(r1.created_at)
            )[0].created_at
        )
      : null;

  // include any unprocessed records from previous runs
  records.unshift(...previousRecords);

  // handle insulin boli, carbs and temp basal rates
  const { treatments: nightscoutTreatments, unprocessedRecords } =
    identifyTreatments(records);

  console.log(
    `Sending ${nightscoutTreatments.length} treatments to nightscout`
  );
  // send them to nightscout
  const treatments = await nightscoutTreatmentsHandler(nightscoutTreatments);

  return {
    treatments: treatments ?? [],
    latestRecordDate,
    unprocessedRecords: unprocessedRecords
      // prevent any of the records that were unprocessed previously to be again in the list of unprocessed records
      .filter((record) => previousRecords.indexOf(record) === -1),
  };
}

// CamAPSFx uploads data to diasend every 5 minutes. (Which is also the time after which new CGM values from Dexcom will be available)
const interval = 5 * 60 * 1000;

export async function getDiasendPatientData({
  diasendUsername,
  diasendPassword,
  diasendClientId,
  diasendClientSecret,
  dateFrom,
  dateTo,
}: {
  diasendUsername: string | undefined;
  diasendPassword: string | undefined;
  diasendClientId: string;
  diasendClientSecret: string;
  dateFrom: Date;
  dateTo: Date;
}) {
  if (!diasendUsername) {
    throw Error("Diasend Username not configured");
  }
  if (!diasendPassword) {
    throw Error("Diasend Password not configured");
  }

  const { access_token: diasendAccessToken } = await obtainDiasendAccessToken(
    diasendClientId,
    diasendClientSecret,
    diasendUsername,
    diasendPassword
  );

  // using the diasend token, now fetch the patient records per device
  const records = await getPatientData(diasendAccessToken, dateFrom, dateTo);
  return records.flatMap((record) =>
    record.data.map<PatientRecordWithDeviceData<PatientRecord>>((r) => ({
      ...r,
      device: record.device,
    }))
  );
}

export function startSynchronization({
  pollingIntervalMs = interval,
  dateTo = new Date(),
  dateFrom = dayjs(dateTo).subtract(pollingIntervalMs, "milliseconds").toDate(),
  treatmentsLoopDelayMs = 0,
  ...syncArgs
}: {
  pollingIntervalMs?: number;
} & SyncDiasendDataToNightScoutArgs &
  SyncDiasendGlucoseToNightscoutArgs & {
    treatmentsLoopDelayMs?: number;
  } = {}) {
  const entriesLoop = new Looper<SyncDiasendGlucoseToNightscoutArgs>(
    pollingIntervalMs,
    async ({ dateTo, ...args } = {}) => {
      const { latestRecordDate } = await syncDiasendGlucoseToNightscout({
        dateTo,
        ...args,
      });
      // remove the dateTo option (to make it default to current date)
      return {
        ...args,
        dateFrom: latestRecordDate
          ? dayjs(latestRecordDate).add(1, "second").toDate()
          : args.dateFrom,
      };
    },
    "Entries"
  ).loop({ dateFrom, ...syncArgs });

  const treatmentsLoop = new Looper<SyncDiasendDataToNightScoutArgs>(
    pollingIntervalMs,
    async ({ dateTo, ...args } = {}) => {
      const { latestRecordDate, unprocessedRecords } =
        await syncDiasendDataToNightscout({
          dateTo,
          ...args,
        });
      // next run's data should be fetched where this run ended, so take a look at the records
      console.log(
        `Scheduling ${unprocessedRecords.length} records for processing in next run`
      );
      // remove the dateTo option
      return {
        ...args,
        previousRecords: unprocessedRecords,
        dateFrom: latestRecordDate
          ? dayjs(latestRecordDate).add(1, "second").toDate()
          : args.dateFrom,
        dateTo: dayjs(dateTo)
          // add the time it takes for the next iteration of the loop to run
          .add(pollingIntervalMs, "milliseconds")
          .toDate(),
      };
    },
    "Treatments"
  ).loop({
    dateFrom: dayjs(dateFrom)
      .subtract(treatmentsLoopDelayMs, "milliseconds")
      .toDate(),
    dateTo: dayjs(dateTo)
      .subtract(treatmentsLoopDelayMs, "milliseconds")
      .toDate(),
    ...syncArgs,
  });

  // return a function that can be used to end the loop
  return () => {
    entriesLoop.stop();
    treatmentsLoop.stop();
  };
}

export function startPumpSettingsSynchronization({
  diasendUsername = config.diasend.username,
  diasendPassword = config.diasend.password,
  // per default synchronize every 12 hours
  pollingIntervalMs = 12 * 3600 * 1000,
  nightscoutProfileName = config.nightscout.profileName,
  nightscoutProfileLoader = async () => await fetchProfile(),
  nightscoutProfileHandler = async (profile: Profile) =>
    await updateProfile(profile),
  importBasalRate = true,
}: {
  diasendUsername?: string;
  diasendPassword?: string;
  pollingIntervalMs?: number;
  importBasalRate?: boolean;
} & NightscoutProfileOptions = {}) {
  if (!diasendUsername) {
    throw Error("Diasend Username not configured");
  }
  if (!diasendPassword) {
    throw Error("Diasend Password not configured");
  }

  if (!nightscoutProfileName) {
    console.info(
      "Not synchronizing pump settings to nightscout profile since profile name is not defined"
    );
    return;
  }

  const looper = new Looper(
    pollingIntervalMs,
    async () => {
      const { client, userId } = await getAuthenticatedScrapingClient({
        username: diasendUsername,
        password: diasendPassword,
      });
      const pumpSettings = await getPumpSettings(client, userId);
      const updatedNightscoutProfile = updateNightScoutProfileWithPumpSettings(
        await nightscoutProfileLoader(),
        pumpSettings,
        { importBasalRate, nightscoutProfileName }
      );
      await nightscoutProfileHandler(updatedNightscoutProfile);
    },
    "Pump Settings"
  ).loop();

  // return a function that can be used to end the loop
  return () => {
    looper.stop();
  };
}
