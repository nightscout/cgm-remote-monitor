import axios, { AxiosError, AxiosInstance } from "axios";
import config from "./config";
import { stringify } from "querystring";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import NodeCache from "node-cache";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import randUserAgent from "rand-user-agent";
import { load } from "cheerio";

type GlucoseUnit = "mg/dl" | "mmol/l";

const tokenCache = new NodeCache({
  checkperiod: 60, // check every 60 seconds for expired items / tokens
});

dayjs.extend(relativeTime);

// for some obscure reason, diasend deviates from the normal ISO date format by removing the timezone information
const diasendIsoFormatWithoutTZ = "YYYY-MM-DDTHH:mm:ss";

interface TokenResponse {
  access_token: string;
  expires_in: string;
  token_type: string;
}

export interface BaseRecord {
  type: "insulin_bolus" | "insulin_basal" | "glucose" | "carb";
  created_at: string;
  flags: { flag: number; description: string }[];
}

export interface GlucoseRecord extends BaseRecord {
  type: "glucose";
  value: number;
  unit: GlucoseUnit;
}

type YesOrNo = "yes" | "no";

export interface BolusRecord extends BaseRecord {
  type: "insulin_bolus";
  unit: "U";
  total_value: number;
  spike_value: number;
  suggested: number;
  suggestion_overridden: YesOrNo;
  suggestion_based_on_bg: YesOrNo;
  suggestion_based_on_carb: YesOrNo;
  programmed_meal?: number;
  programmed_bg_correction?: number;
}
export interface CarbRecord extends BaseRecord {
  type: "carb";
  value: string; // for some reason, carbs are not given as numbers but a string 🤷
  unit: "g";
}

export interface BasalRecord extends BaseRecord {
  type: "insulin_basal";
  unit: "U/h";
  value: number;
}

export type PatientRecord =
  | GlucoseRecord
  | BolusRecord
  | BasalRecord
  | CarbRecord;

export interface DeviceData {
  serial: string;
  manufacturer: string;
  model: string;
}

export type PatientRecordWithDeviceData<
  T extends PatientRecord = PatientRecord
> = T & {
  device: DeviceData;
};

const diasendClient = axios.create({
  baseURL: "https://api.diasend.com/1",
  headers: {
    "User-Agent": "diasend/1.13.0 (iPhone; iOS 15.5; Scale/3.00)",
  },
});

export async function obtainDiasendAccessToken(
  clientId: string = config.diasend.clientId,
  clientSecret: string = config.diasend.clientSecret,
  username: string,
  password: string,
  allowCache = true
): Promise<TokenResponse> {
  let token = tokenCache.get<TokenResponse>("token");
  if (token === undefined || !allowCache) {
    const response = await diasendClient.post<TokenResponse>(
      "/oauth2/token",
      stringify({
        grant_type: "password",
        password,
        scope: "PATIENT DIASEND_MOBILE_DEVICE_DATA_RW",
        username,
      }),
      { auth: { password: clientSecret, username: clientId } }
    );

    token = response.data;
    tokenCache.set("token", token, parseInt(token.expires_in));
  }

  return token;
}

type DiasendCGMResponse = { data: PatientRecord[]; device: DeviceData }[];

export async function getPatientData(
  accessToken: string,
  date_from: Date,
  date_to: Date
): Promise<DiasendCGMResponse> {
  console.log(
    `Fetching diasend patient records between ${date_from.toISOString()} and ${date_to.toISOString()}`
  );
  const response = await diasendClient.get<DiasendCGMResponse>(
    "/patient/data",
    {
      params: {
        type: "cgm",
        date_from: dayjs(date_from).format(diasendIsoFormatWithoutTZ),
        date_to: dayjs(date_to).format(diasendIsoFormatWithoutTZ),
        unit: "mg_dl",
      },
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  return response.data;
}

// SCRAPER for website
const diasendWebsiteBaseUrl = "https://international.diasend.com/";

export async function getAuthenticatedScrapingClient({
  username,
  password,
  country = 108,
  locale = "en_US",
}: {
  username: string;
  password: string;
  country?: number;
  locale?: string;
}) {
  const client = wrapper(
    axios.create({
      baseURL: diasendWebsiteBaseUrl,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
      jar: new CookieJar(),
      // use a random user agent to scracpe
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      headers: { "User-Agent": randUserAgent() as string },
    })
  );
  try {
    await client.post(
      "/diasend/includes/account/login.php",
      stringify({ country, locale, user: username, passwd: password }),
      {
        // withCredentials: true,
        // we don't want the actual redirect to the dashboard to happen (as it wouldn't have cookies set)
        maxRedirects: 0,
      }
    );
    throw new Error('Login request cannot be "successful"');
  } catch (err) {
    const redirectResponse = (err as AxiosError).response;
    const userId = redirectResponse?.headers["location"].match(
      /\/reports\/(?<userId>.*)\/summary/
    )?.groups?.userId;
    if (!userId) {
      throw new Error("Could not find userId to scrape diasend");
    }

    // remember the PHPSESSID (to authenticate future requests) --> done automatically by the cookiejar
    // and the "userId" which can be obtained from the redirect happening after login and is required to access reports etc.
    return { client, userId };
  }
}

export interface PumpSettings {
  basalProfile: [string, number][];
  insulinCarbRatioProfile: [string, number][];
  insulinSensitivityProfile: [string, number][];
  bloodGlucoseTargetLow?: number;
  bloodGlucoseTargetHigh?: number;
  insulinOnBoardDurationHours?: number;
  units?: "mg/dl" | "mmol/l";
}

export async function getPumpSettings(
  client: AxiosInstance,
  userId: string
): Promise<PumpSettings> {
  const { data } = await client.get<string>(
    `/reports/${userId}/insulin/pump-settings`
  );
  const $ = load(data);

  // find the active basal profile
  const activeBasalProfile = $("td")
    .filter((_, ele) => $(ele).text() === "Active basal program")
    .next()
    .text();
  const basalProfile: [string, number][] = (
    $("h4")
      .filter((_, e) =>
        $(e).text().startsWith(`Program: ${activeBasalProfile}`)
      )
      .next("table")
      // get all rows except for header row
      .find("tr:not(:first)")
      .map((_, row) =>
        $(row)
          // get all cells of a row
          .children("td")
          // take only the last two cells (start time and rate)
          .slice(-2)
          .map((_, cell) => $(cell).text())
      )
      .get() as [string, string][]
  ).map(([startTime, rate]) => [startTime, parseFloat(rate)]);

  // identify the carbs ratio (I:C)
  const insulinCarbRatioProfile: [string, number][] = (
    $("h3")
      .filter((_, e) => $(e).text() === "I:C ratio settings")
      .next("table")
      .find("table")
      .find("tr:not(:first)")
      .map((_, row) =>
        $(row)
          // get all cells of a row
          .children("td")
          // take only the last two cells (start time and rate)
          .slice(-2)
          .map((_, cell) => $(cell).text())
      )
      .get() as [string, string][]
  ).map(([startTime, rate]) => [startTime, parseFloat(rate)]);

  // identify the insulin sensitivity factor(s)
  const insulinSensitivityProfile: [string, number][] = (
    $("h3")
      .filter((_, e) => $(e).text() === "ISF programs")
      .next("table")
      .find("table")
      .find("tr:not(:first)")
      .map((_, row) =>
        $(row)
          // get all cells of a row
          .children("td")
          // take only the last two cells (start time and rate)
          .slice(-2)
          .map((_, cell) => $(cell).text())
      )
      .get() as [string, string][]
  ).map(([startTime, rate]) => [startTime, parseFloat(rate)]);

  // lower goal of blood glucose
  const bloodGlucoseTargetLowElement = $("td")
    .filter((_, ele) => $(ele).text() === "BG goal low")
    .next()
    .text();

  const bloodGlucoseTargetLow = bloodGlucoseTargetLowElement.length
    ? parseInt(bloodGlucoseTargetLowElement.split(" ")[0])
    : undefined;

  const units = bloodGlucoseTargetLowElement
    ? bloodGlucoseTargetLowElement.split(" ")[1].toLowerCase() === "mg/dl"
      ? "mg/dl"
      : "mmol/l"
    : undefined;

  // high goal of blood glucose
  const bloodGlucoseTargetHighElement = $("td")
    .filter((_, ele) => $(ele).text() === "BG goal high")
    .next()
    .text();
  const bloodGlucoseTargetHigh = bloodGlucoseTargetHighElement
    ? parseInt(bloodGlucoseTargetHighElement.split(" ")[0])
    : undefined;

  const iobDurationHoursElement = $("td")
    .filter((_, ele) => $(ele).text() === "Insulin-On-Board Duration")
    .next()
    .text();
  // insulin on board duration
  const iobDurationHours = iobDurationHoursElement
    ? parseInt(iobDurationHoursElement.split(" ")[0])
    : undefined;

  return {
    basalProfile,
    insulinCarbRatioProfile,
    insulinSensitivityProfile,
    bloodGlucoseTargetLow,
    bloodGlucoseTargetHigh,
    insulinOnBoardDurationHours: iobDurationHours,
    units,
  };
}
