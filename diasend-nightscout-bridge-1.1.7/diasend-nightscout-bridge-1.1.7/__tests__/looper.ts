import { nextTick } from "process";
import { Looper } from "../Looper";

describe("testing looper class", () => {
  jest.useFakeTimers({ doNotFake: ["nextTick"] });
  jest.spyOn(global, "setTimeout");

  test("it periodically executes the given looping function", async () => {
    // Given a function to be run in a loop
    const loopFunction = jest.fn();
    loopFunction.mockResolvedValue(undefined);

    // When starting the looper and letting it run on an interval of 100ms
    const looper = new Looper(100, loopFunction, "Test");
    looper.loop();

    for (let numberOfRuns = 1; numberOfRuns < 6; numberOfRuns++) {
      // Then expect the looping function to have been run
      expect(loopFunction).toBeCalledTimes(numberOfRuns);
      // Wait for the callback of the promise to run:
      await new Promise(nextTick);
      // a new run of the loop should have been scheduled
      expect(setTimeout).toHaveBeenCalledTimes(numberOfRuns);
      // run all timers
      jest.runOnlyPendingTimers();
    }

    // Cleanup
    looper.stop();
  });

  test("it periodically executes the given looping function with the args returned from the previous loop", async () => {
    type LoopArgs = string;

    // Given a function to be run in a loop which returns arguments for the next run
    const loopFunction = jest.fn(async (args?: LoopArgs) =>
      Promise.resolve(args! + " updated")
    );

    // When starting the looper and letting one loop to run through
    const looper = new Looper<LoopArgs>(100, loopFunction, "Test");
    looper.loop("original argument");
    await new Promise(nextTick);
    jest.runOnlyPendingTimers();

    // Then expect the looping function to have been called with the arguments calculated int the first run
    expect(loopFunction).toHaveBeenCalledWith("original argument updated");
  });

  test("it retries the last iteration if fn fails", async () => {
    type LoopArgs = string;

    // Given a function to be run in a loop which throws an error
    const loopFunction = jest.fn(async () => Promise.reject("Failed!"));

    // When starting the looper and letting one loop to run through
    const looper = new Looper<LoopArgs>(100, loopFunction, "Test");
    looper.loop("original argument");
    loopFunction.mockClear();
    await new Promise(nextTick);
    jest.runOnlyPendingTimers();

    // Then expect the looping function to have been called again with the arguemnts of the first run
    expect(loopFunction).toBeCalledTimes(1);
    expect(loopFunction).toHaveBeenCalledWith("original argument");
  });
});
