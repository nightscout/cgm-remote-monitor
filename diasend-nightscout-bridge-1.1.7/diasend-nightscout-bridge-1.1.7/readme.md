# Diasend -> Nightscout Bridge #WeAreNotWaiting

Synchronizes treatments (insulin boli, temp basal changes) as well as continuous glucose values (CGV) from [diasend] to [nightscout]. This can e.g. help [CamAPS FX] users to view their treatments and glucose values via nightscout.

While diasend will eventually be replaced by glooko which will (presumably) provide a more open API to access the data and forward it to nightscout, this project can help in the meantime. #WeAreNotWaiting

## Supported Features / Data

✅ Glucose Values (CGM) <br />
✅ Correction and Meal Boli <br />
✅ Carb Corrections <br />
✅ Basal rates (Pre-programmed) <br />
✅ Basal rates (temporary, as applied by the CamAPS FX hybrid closed loop) <br />
✅ Pump settings (see [issue][pump-settings-issue])

## A word of advice

Depending on your use case and requirements, you may not need a synchronization solution from diasend to nightscout as provided by this project. 

If all you need is to monitor the glucose values remotely via nightscout and don't want to use diasend for it, or the delay of uploading to diasend and synchronizing to nightscout (5+ minutes) is unbearable, I recommend taking a look at running [xDrip in Companion mode][xDrip Companion] which will provide glucose values faster to nightscout than this project can.

However, if you need to see more data than the pure continuous glucose values (CGV) within nightscout, e.g. insulin boli, carb corrections, basal rates or temporary adjustments of basal rates, the diasend-nightscout-bridge has got you covered.

And finally - you don't have to pick: You can run both the xDrip Companion and the diasend-nightscout-bridge to get the best out of both worlds: Near-Realtime blood glucose monitoring and trends as well as proper import of all treatments issued via CamAPS FX / stored on diasend. For more details, see [here][xDrip + bridge]

## Configuration

The following environment variables are required, also see [env.example](./.env.example):

- `DIASEND_USERNAME`: the username / email address of your disasend account
- `DIASEND_PASSWORD`: the password of your disasend account
- `NIGHTSCOUT_URL`: the url of your nightscout instance
- `NIGHTSCOUT_API_SECRET`: the api secret to communicate with your nightscout instance

Optionally, you can also provide the following values:

- `TZ`: the timezone from which the glucose values have been sent to diasend. If you run this project on your local machine, this configuration will likely not be necessary. If your run it on a dedicated server, though it must be configured to avoid an [offset in the data due to timezone issues]. Usually the timezone in which your device exporting data to diasend is.
- `NIGHTSCOUT_PROFILE_NAME`: The name of the profile in nightscout to which to synchronize the diasend pump settings. Defaults to undefined which means the pump settings will not be synchronized. When set, the specified profile will be overwritten with the settings from diasend so be careful.
- `DIASEND_CLIENT_ID`: client id for authorization against diasend. Defaults to `a486o3nvdu88cg0sos4cw8cccc0o0cg.api.diasend.com`
- `DIASEND_CLIENT_SECRET`: client secret for authorization against diasend. Defaults to `8imoieg4pyos04s44okoooowkogsco4`

## Running

There are two different ways to use this project in order to synchronize data from diasend to nightscout. You can either [run this bridge standalone](#standalone) in which case it will pull the data via the diasend API and forward it to nightscout via nightscout's REST API. The downside here is that you need to run it on an additional server or PC which is why the more intuitive way is [running the bridge as a plugin directly as part of nightscout](#nightscout-plugin). This way, the data will still be pulled from diasend via its HTTP API but the data will directly be imported into nightscout without going through its REST API, which should likely be more reliable and remove the need to run the bridge separately.

### Nightscout Plugin

To run this bridge as a plugin directly in nightscout, you can simply install the bridge as an npm package within your nightscout installation and implement a handler to import the data directly into nightscout. A sample implementation can be found here: https://github.com/nightscout/cgm-remote-monitor/compare/master...burnedikt:cgm-remote-monitor:master?expand=1.

Once installed, the plugin needs to be enabled via nightscout's `ENABLE="... diasend ..."` environment variable and the following two environment variables need to be defined: `DIASEND_USERNAME` and `DIASEND_PASSWORD` so that nightscout will automatically pull data in from diasend.

A future goal is to either merge the example implementation above upstream or publish the bridge as a nightscout plugin directly to npm so that the integration with nightscout becomes easier.

### Standalone / Sidecar

To run the bridge, ensure that all required environment variables are set. You can set environment variables manually or create a file called `.env` and fill it with values similar to [env.example](./.env.example). All variables defined within the `.env` file will be loaded automatically thanks to [dotenv].

Next, run `yarn install` to install all dependencies.

Finally run the following command to synchronize CGV from diasend to nightscout every 5 minutes:

```sh
yarn start
```

#### Docker

You can also run the bridge as a docker container either side-by-side with nightscout (if it is running containerized using `docker` or `docker-compose`). To do so, you can use the [Dockerfile](./Dockerfile) within this repository to build the bridge into a docker container image:

```sh
docker build -t diasend2nightscout .
```

You can use the resulting container image (in this case named `diasend2nightscout`) to run the bridge as a container using `docker-compose` like:

```yaml
# nightscout services

services:
  diasend-bridge:
    image: diasend2nightscout
    # alternatively, you can also configure a build section here to skip the explicit build step above. uncomment the following lines to do so
    # build:
    #   context: .
    env:
      DIASEND_USERNAME: <diasend-username>
      DIASEND_PASSWORD: <diasend-password>
      NIGHTSCOUT_URL: <url-of-nightscout-instance>
      NIGHTSCOUT_API_SECRET: <retracted>
      # ... other environment variables for configuration, see readme
```

... or directly using docker à la `docker run -e DIASEND_USERNAME=... -e DIASEND_PASSWORD=...diasend2nightscout`. [See here][docker-deployment-issue] for more details.

## Notes & Known Issues

- Up to 10 minutes delay of data: Depending on how often data is exported to diasend, the data (e.g. glucose values) can arrive with a delay in nightscout. E.g. CamAPS FX only
exports data to diasend every 5 minutes and this project then needs to retrieve the data from diasend so it can take up to 10 minutes until it will appear in
nightscout. This delay can be partially reduced by altering the polling interval (currently only [controllable via source code][change-polling-interval]).
- Due to the nature of the data provided by diasend and the polling loop, we need to delay processing of some events into the next loop running x minutes later as e.g. meal boli are split on the diasend side into separate events at different times so sometimes not all events belonging together are in the same batch of events to be processed, thereby forcing us to check them again in the next loop before deciding what type of treatment should be sent to diasend. See [this issue][postponed-carb-events-issue] for more details.
- Timezone issues: Due to diasend not providing any timezone information on dates, the timezone of the machine / server running this project
  needs to match the timezone in which the values were sent to diasend, i.e. the timezone of the device generating the data for diasend, see also the [configuration section above](#configuration)

## Further information

This project works by connecting to **diasend's internal (!) API, which may change at any time without warning, so use with caution**, and pulling the latest number of
so-called _patient data_, converts it to CGV values compatible with nightscout and then uses the nightscout API to push those values.

More information and sample calls on the diasend-api can be found in [diasend-api.http](./diasend-api.http) which can be used with VSCode's [REST Client plugin]
to quickly try out the API calls.

This project is written in Typescript.

## Related Projects

- [Share2NightScout Bridge]: Similarly to us pulling data from diasend and sending it to nightscout, this projects pulls the data from dexcom web service and pushes it to nightscout. Initially created by [Scott Hanselmann]
- [minimed-connect-to-nightscout]: Scrapes the Minimed website instead of using an API but the bottom line is the same: Pulls data from minimed and pushes it to nightscout
- [diasend2nightscout-bridge]: Has the same goal of this project but up to now did not provide an end-to-end solution for synchronizing the data between diasend and nightscout as far as I can tell

## Contributing

[File an issue] if you'd like to give feedback, request an enhancement, or report a bug.

Pull requests are welcome.

## Disclaimer

This project is intended for educational and informational purposes only. It relies on a series of fragile components and assumptions, any of which may break at any time. It is not FDA approved and should not be used to make medical decisions. It is neither affiliated with nor endorsed by diasend / glooko, and may violate their Terms of Service.

[diasend]: https://www.diasend.com/
[Share2NightScout Bridge]: https://github.com/nightscout/share2nightscout-bridge
[nightscout]: https://github.com/nightscout/cgm-remote-monitor
[Scott Hanselmann]: https://www.hanselman.com/blog/bridging-dexcom-share-cgm-receivers-and-nightscout
[minimed-connect-to-nightscout]: https://github.com/nightscout/minimed-connect-to-nightscout
[REST Client plugin]: https://marketplace.visualstudio.com/items?itemName=humao.rest-client
[diasend2nightscout-bridge]: https://github.com/funkstille/diasend2nightscout-bridge
[change-polling-interval]: https://github.com/burnedikt/diasend-nightscout-bridge/blob/f29f671dfa74bf9b14ae8610d84c8d58a654c37f/index.ts#L190
[pump-settings-issue]: https://github.com/burnedikt/diasend-nightscout-bridge/issues/1
[File an issue]: https://github.com/burnedikt/diasend-nightscout-bridge/issues/new/choose
[docker-deployment-issue]: https://github.com/burnedikt/diasend-nightscout-bridge/issues/16
[postponed-carb-events-issue]: https://github.com/burnedikt/diasend-nightscout-bridge/issues/15#issuecomment-1297664209
[dotenv]: https://www.npmjs.com/package/dotenv
[CamAPS FX]: https://camdiab.com
[xDrip Companion]: https://xdrip.readthedocs.io/en/latest/install/companion/
[xDrip + bridge]: https://github.com/burnedikt/diasend-nightscout-bridge/issues/23#issuecomment-1370283732
