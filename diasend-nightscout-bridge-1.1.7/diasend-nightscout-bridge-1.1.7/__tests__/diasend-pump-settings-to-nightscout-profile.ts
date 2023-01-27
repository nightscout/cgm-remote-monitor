import axios, { AxiosInstance } from "axios";
import { getPumpSettings, PumpSettings } from "../diasend";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("testing conversion of diasend stored pump-settings to nightscout profile", () => {
  test("handles non-existing pump settings gracefully", async () => {
    // Given that the pump settings page within diasend does not contain any meanintful data
    const client: AxiosInstance = mockedAxios;
    mockedAxios.get.mockResolvedValueOnce({ data: "<html></html>" });

    // When attempting to extract the pump settings
    const pumpSettings = await getPumpSettings(client, "42");

    // Then expect it to stay empty
    expect(pumpSettings).toEqual<PumpSettings>({
      basalProfile: [],
      bloodGlucoseTargetHigh: undefined,
      bloodGlucoseTargetLow: undefined,
      insulinCarbRatioProfile: [],
      insulinOnBoardDurationHours: undefined,
      insulinSensitivityProfile: [],
      units: undefined,
    });
  });

  test("extracts BG goals", async () => {
    // Given that the pump settings page within diasend does not contain any meanintful data
    const client: AxiosInstance = mockedAxios;
    mockedAxios.get.mockResolvedValueOnce({
      data: `<table class="table table-condensed"><caption>General</caption><thead><tr><th>Setting</th><th>Value</th></tr>
    </thead><tbody><tr><td>BG goal low</td><td>70 mg/dL</td></tr>
    <tr><td>BG goal high</td><td>180 mg/dL</td></tr>
    <tr><td>Insulin-On-Board</td><td>Enabled</td></tr>
    <tr><td>Insulin-On-Board Duration</td><td>18 h</td></tr>
    </tbody></table>`,
    });

    // When attempting to extract the pump settings
    const pumpSettings = await getPumpSettings(client, "42");

    // Then expect it to stay empty
    expect(pumpSettings).toEqual<PumpSettings>({
      basalProfile: [],
      bloodGlucoseTargetHigh: 180,
      bloodGlucoseTargetLow: 70,
      insulinCarbRatioProfile: [],
      insulinOnBoardDurationHours: 18,
      insulinSensitivityProfile: [],
      units: "mg/dl",
    });
  });
});
