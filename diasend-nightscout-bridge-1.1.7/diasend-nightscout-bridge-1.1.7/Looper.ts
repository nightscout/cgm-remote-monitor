import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

dayjs.extend(relativeTime);

export class Looper<TLoopArgs = void> {
  intervalMs: number;
  loopingFun: (args?: TLoopArgs) => Promise<TLoopArgs>;
  timeoutHandle: NodeJS.Timeout | undefined | number;
  name: string;

  constructor(
    intervalMs: number,
    loopingFun: (args?: TLoopArgs) => Promise<TLoopArgs>,
    name: string
  ) {
    this.intervalMs = intervalMs;
    this.loopingFun = loopingFun;
    this.name = name;
  }

  loop(args?: TLoopArgs) {
    let nextArgs: TLoopArgs | undefined;
    // run the looping function, then schedule the next run (unless it should be stopped)
    void this.loopingFun(args)
      .then((argsCalculatedByLoop) => {
        // schedule next run with the new args calcualted by this run
        nextArgs = argsCalculatedByLoop;
      })
      .catch((error) => {
        console.error(error);
        // retry with the current set of args
        nextArgs = args;
      })
      .finally(() => {
        // if this.timeoutHandle is set to 0 when we get here, don't schedule a re-run. This is the exit condition
        // and prevents the synchronization loop from continuing if the timeout is cleared while already running the sync
        if (this.timeoutHandle == 0) return;

        // schedule the next run
        console.log(
          `Next run (${this.name}) will be in ${dayjs()
            .add(this.intervalMs, "milliseconds")
            .fromNow()}...`
        );
        this.timeoutHandle = setTimeout(
          this.loop.bind(this, nextArgs),
          this.intervalMs
        );
      });
    return this;
  }

  stop() {
    clearTimeout(this.timeoutHandle);
  }
}
