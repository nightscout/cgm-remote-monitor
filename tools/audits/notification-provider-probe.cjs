const root = process.argv[2],
  mode = process.argv[3];
const http = require("http");
const started = performance.now();
let ctx;
(async () => {
  const Module = require("module");
  const originalLoad = Module._load;
  const clients = [];
  const wrappers = new WeakMap();
  let sends = 0,
    pushes = 0,
    fixtureEnv;
  Module._load = function (name, ...args) {
    const value = originalLoad.call(this, name, ...args);
    if (name === "pushover-notifications") {
      if (!wrappers.has(value)) {
        wrappers.set(value, function (options) {
          const provider = new value(options);
          provider.send = (message, callback) => {
            if (message.user !== "fixture-user")
              throw new Error("Wrong Pushover recipient");
            pushes++;
            callback(null, { receipt: "fixture-receipt" });
          };
          return provider;
        });
      }
      return wrappers.get(value);
    }
    if (name !== "@parse/node-apn") return value;
    if (!wrappers.has(value)) {
      const Provider = value.Provider;
      wrappers.set(value, {
        ...value,
        Provider: function (options) {
          const provider = new Provider(options);
          clients.push(new WeakRef(provider.client));
          // Keep actual notification compilation/provider lifetime; block external delivery.
          provider.client.write = async (notification, device) => {
            if (!notification.body.includes("cancel-temporary-override"))
              throw new Error("Wrong fixture payload");
            sends++;
            return { device };
          };
          return provider;
        },
      });
    }
    return wrappers.get(value);
  };
  if (mode === "enabled") {
    process.env.PUSHOVER_API_TOKEN = "fixture-token";
    process.env.PUSHOVER_USER_KEY = "fixture-user";
    process.env.ENABLE = "careportal pushover";
  }
  const bootFile = require.resolve(root + "/lib/server/bootevent");
  const boot = require(bootFile);
  require.cache[bootFile].exports = (env, language) => {
    fixtureEnv = env;
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
    const { privateKey } = require("crypto").generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    fixtureEnv.extendedSettings.loop = {
      apnsKey: privateKey.export({ type: "pkcs8", format: "pem" }),
      apnsKeyId: "FIXTUREKEY",
      developerTeamId: "TEAMID1234",
    };
    ctx.ddata.profiles = [
      {
        loopSettings: {
          deviceToken: "fixture-token",
          bundleIdentifier: "example.fixture",
        },
      },
    ];
    for (let n = 0; n < 20; n++) {
      await new Promise((resolve, reject) =>
        ctx.loop.sendNotification(
          { eventType: "Temporary Override Cancel" },
          "127.0.0.1",
          (error) => (error ? reject(new Error(error)) : resolve()),
        ),
      );
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (!ctx.pushover) throw new Error("Configured Pushover missing");
    for (let n = 0; n < 20; n++) {
      await new Promise((resolve, reject) =>
        ctx.pushover.send(
          {
            title: "Fixture",
            message: "Fixture details",
            level: ctx.levels.INFO,
          },
          (error) => (error ? reject(error) : resolve()),
        ),
      );
    }
    if (pushes !== 20)
      throw new Error("Pushover did not complete 20 mocked sends");
    if (sends !== 20 || clients.length !== 20)
      throw new Error("Enabled fixture did not send 20 notifications");
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
    providerClientsCreated: clients.length,
    providerClientsRetained: clients.filter((ref) => ref.deref()).length,
    providerSends: sends,
    pushoverSends: pushes,
    pushoverLoaded: Object.keys(require.cache).some((p) =>
      p.includes("/pushover-notifications/"),
    ),
    apnLoaded: Object.keys(require.cache).some((p) =>
      p.includes("/@parse/node-apn/"),
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
  console.log(
    "PROBE_TEARDOWN " +
      JSON.stringify({ actorStatus: result.actorAfterTeardown }),
  );
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
