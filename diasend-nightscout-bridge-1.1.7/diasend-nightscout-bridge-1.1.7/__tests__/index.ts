import dayjs from "dayjs";

const dependentFunctionParameters = ({
  dateTo = new Date(),
  dateFrom = dayjs(dateTo).subtract(10, "minutes").toDate(),
}: {
  dateTo?: Date;
  dateFrom?: Date;
} = {}) => dateFrom;

describe("testing diasend-to-nightscout conversion loop", () => {
  test("default start of sync period depends on end of sync period", async () => {
    // Given a specified end date for the synchronization period
    const endDate = new Date("2022-01-01T12:00:12.000Z");

    // When attempting to sync the diasend data to nightscout
    const startDate = dependentFunctionParameters({ dateTo: endDate });

    // Then expect the start of the period to be 10 minutes prior to the specified end date
    expect(startDate.toISOString()).toBe("2022-01-01T11:50:12.000Z");
  });
});
