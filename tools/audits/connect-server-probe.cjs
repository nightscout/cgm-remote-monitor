const root = process.argv[2],
  mode = process.argv[3];
const http = require("http");
const started = performance.now();
let ctx;
(async () => {
  let sourceRequests = 0;
  const source = http.createServer((request, response) => {
    sourceRequests++;
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify(
        request.url === "/api/v1/verifyauth"
          ? { status: 200, message: { canRead: true } }
          : [],
      ),
    );
  });
  await new Promise((resolve) => source.listen(0, "127.0.0.1", resolve));
  if (mode === "enabled") {
    process.env.CONNECT_SOURCE = "nightscout";
    process.env.CONNECT_SOURCE_ENDPOINT =
      "http://127.0.0.1:" + source.address().port;
  }
  const bootFile = require.resolve(root + "/lib/server/bootevent");
  const boot = require(bootFile);
  require.cache[bootFile].exports = (env, language) => {
    const pipeline = boot(env, language);
    const run = pipeline.boot;
    pipeline.boot = (callback) =>
      run.call(pipeline, (context) => {
        ctx = context;
        callback(context);
      });
    return pipeline;
  };
  require(root + "/lib/server/server.js");
  const deadline = Date.now() + 15000;
  while ((!ctx || ctx.runtimeState !== "loaded") && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  if (!ctx || ctx.runtimeState !== "loaded")
    throw new Error("Server not loaded");
  if (mode === "enabled") {
    if (!ctx.nightscoutConnect) throw new Error("Enabled connector missing");
    while (!sourceRequests && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    if (!sourceRequests)
      throw new Error("Enabled connector did not contact local fixture");
  }
  const startupMs = performance.now() - started;
  await new Promise((resolve) => setTimeout(resolve, 500));
  const latencies = [];
  for (let n = 0; n < 10; n++) {
    const start = performance.now();
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
    latencies.push(performance.now() - start);
  }
  for (let n = 0; n < 3; n++) {
    global.gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
  const result = {
    mode,
    node: process.version,
    startupMs,
    memory: process.memoryUsage(),
    modules: Object.keys(require.cache).length,
    connectorLoaded: Object.keys(require.cache).some((p) =>
      p.includes("/nightscout-connect/"),
    ),
    actorStatus: ctx.nightscoutConnect ? ctx.nightscoutConnect().status : null,
    resources: process.getActiveResourcesInfo(),
    listeners: Object.fromEntries(
      ctx.bus
        .eventNames()
        .map((event) => [event, ctx.bus.listenerCount(event)]),
    ),
    latencies,
  };
  console.log("PROBE_RESULT " + JSON.stringify(result));
  ctx.bus.teardown();
  result.actorAfterTeardown = ctx.nightscoutConnect
    ? ctx.nightscoutConnect().status
    : null;
  if (ctx.nightscoutConnect) await ctx.nightscoutConnect.stop();
  source.closeAllConnections();
  await new Promise((resolve) => source.close(resolve));
  console.log(
    "PROBE_TEARDOWN " +
      JSON.stringify({ actorStatus: result.actorAfterTeardown }),
  );
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
