const root = process.argv[2];
const mode = process.argv[3];
const http = require("http");
const inspector = require("inspector");
const Module = require("module");
const started = performance.now();
let ctx, fixtureEnv;
const caches = [];
const originalLoad = Module._load;
Module._load = function (name, parent, ...args) {
  const value = originalLoad.call(this, name, parent, ...args);
  if (
    name !== "node-cache" ||
    !parent.filename.endsWith("/lib/server/pushnotify.js")
  )
    return value;
  return function (options) {
    const cache = new value(options);
    caches.push(cache);
    return cache;
  };
};
const immediate = () => new Promise((resolve) => setImmediate(resolve));
async function collect() {
  for (let n = 0; n < 3; n++) {
    global.gc();
    await immediate();
  }
}
function allocationBytes(node) {
  return (
    node.selfSize +
    node.children.reduce((sum, child) => sum + allocationBytes(child), 0)
  );
}
(async () => {
  if (!["no-receipt", "receipt"].includes(mode))
    throw new Error("Choose no-receipt or receipt");
  const bootFile = require.resolve(root + "/lib/server/bootevent");
  const boot = require(bootFile);
  require.cache[bootFile].exports = (env, language) => {
    fixtureEnv = env;
    const pipeline = boot(env, language),
      run = pipeline.boot;
    pipeline.boot = (callback) =>
      run.call(pipeline, (context) => {
        ctx = context;
        callback(context);
      });
    return pipeline;
  };
  require(root + "/lib/server/server.js");
  const deadline = Date.now() + 15000;
  while ((!ctx || ctx.runtimeState !== "loaded") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!ctx || ctx.runtimeState !== "loaded")
    throw new Error("Server not loaded");
  const startupMs = performance.now() - started;
  fixtureEnv.settings.isAlarmEventEnabled = () => true;
  ctx.maker = null;
  let sends = 0;
  ctx.pushover = {
    send(notify, callback) {
      sends++;
      callback(
        null,
        JSON.stringify(
          mode === "receipt" ? { receipt: "receipt-" + notify.notifyhash } : {},
        ),
      );
    },
  };
  async function statusRequest() {
    const before = performance.now();
    await new Promise((resolve, reject) =>
      http
        .get(
          "http://127.0.0.1:" + process.env.PORT + "/api/v1/status.json",
          (response) => {
            if (response.statusCode !== 200)
              return reject(new Error("HTTP " + response.statusCode));
            response.resume();
            response.on("end", resolve);
          },
        )
        .on("error", reject),
    );
    return performance.now() - before;
  }
  for (let n = 0; n < 10; n++) await statusRequest();
  await collect();
  const beforeHeap = process.memoryUsage().heapUsed;
  const session = new inspector.Session();
  session.connect();
  const post = (method, params = {}) =>
    new Promise((resolve, reject) =>
      session.post(method, params, (error, result) =>
        error ? reject(error) : resolve(result),
      ),
    );
  await post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const originalInfo = console.info;
  console.info = () => {};
  const workloadStarted = performance.now();
  function sendUnique(index) {
    ctx.pushnotify.emitNotification({
      notifyhash: "fixture-" + index,
      plugin: { name: "fixture" },
      level: ctx.levels.WARN,
      title: "Fixture",
      message: "Fixture payload",
      group: "fixture-group",
      large: Array.from({ length: 1000 }, (_, item) => ({
        item,
        detail: `fixture-${index}-${item}-${"x".repeat(64)}`,
      })),
    });
  }
  try {
    for (let n = 0; n < 100; n++) sendUnique(n);
    for (let cycle = 0; cycle < 5; cycle++) {
      for (let n = 0; n < 100; n++)
        ctx.pushnotify.emitNotification({ notifyhash: "fixture-" + n });
    }
  } finally {
    console.info = originalInfo;
  }
  const workloadMs = performance.now() - workloadStarted;
  let profile = (await post("HeapProfiler.stopSampling")).profile;
  const sampledAllocationBytes = allocationBytes(profile.head);
  if (process.argv[4])
    require("fs").writeFileSync(process.argv[4], JSON.stringify(profile));
  profile = null;
  session.disconnect();
  if (sends !== 100)
    throw new Error("Expected 100 sends with 500 duplicates suppressed");
  await immediate();
  await collect();
  const memory = process.memoryUsage();
  const latencies = [];
  for (let n = 0; n < 10; n++) latencies.push(await statusRequest());
  const recent = caches.find((cache) => cache.options.checkperiod === 20);
  const receipts = caches.find((cache) => cache.options.checkperiod === 300);
  if (!recent || !receipts)
    throw new Error("Expected real notification caches");
  // Read pinned node-cache internals without cloning the retained values again.
  const recentTypes = [
    ...new Set(Object.values(recent.data).map((entry) => typeof entry.v)),
  ];
  console.log(
    "PROBE_RESULT " +
      JSON.stringify({
        mode,
        node: process.version,
        startupMs,
        workloadMs,
        sampledAllocationBytes,
        sampledBytesPerEmission: sampledAllocationBytes / 600,
        sampledAllocationBytesPerSecond:
          sampledAllocationBytes / (workloadMs / 1000),
        beforeHeap,
        retainedGrowth: memory.heapUsed - beforeHeap,
        memory,
        sends,
        duplicates: 500,
        recentEntries: recent.keys().length,
        receiptEntries: receipts.keys().length,
        recentTypes,
        modules: Object.keys(require.cache).length,
        resources: process.getActiveResourcesInfo(),
        listeners: Object.fromEntries(
          ctx.bus
            .eventNames()
            .map((name) => [name, ctx.bus.listenerCount(name)]),
        ),
        latencies,
      }),
  );
  ctx.bus.teardown();
  caches.forEach((cache) => cache.close());
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
