# Deploying Nightscout onto Pivotal Web Services

Pivotal Web Services (PWS) is a public cloud platform offered by [Pivotal Software, Inc](http://pivotal.io).

To publish a nightscout site on PWS, you will follow the procedure here, in this order:

1. Fork the repo to get a copy of the app
2. Create an account in PWS to host your app
3. Create an instance of a database for the app to use
4. Install the `CF CLI` tool to talk to PWS
5. Login to PWS from the command line and point at where you want to place your app
6. Prepare your copy of nightscout to run in PWS
7. Deploy the nightscout app to PWS from the command line
8. Adjust any settings in nightscout needed prior to running it
9. Run the app and connect for the first time
## Forking The Repo
Fork it
## Creating An Account in PWS
Get it
## Create mLab MongoDB Service

PWS makes it really easy to get partner services for use with your apps. For nightscout, the app requires a database, which we get from MongoDB, who happens to be a member of the PWS Marketplace, among many others.

To get a free database instance for your app, follow this directions:

In the PWS UI
1. Log-in to your account and choose Marketplace from the left-hand column.
2. In the list of Services, scroll to mLab, Fully managed MongoDB-as-a-Service and click on it.
3. You should see one Service Tier: Sandbox free. Click the Select This Plan button.
4. Fill in the form that pops up:

`Instance Name` = a name for this database. It can be anything, like "my-nightscout-db"

`Add To Space` =  The name of the Space that your nightscout app resides in. This is probably Development, the default Space PWS gives you, unless you made a new Space for the app.

`Bind To App (Optional)` = The name you used for nightscout when you uploaded it. If you haven't yet, that's OK, it can be bound later. This is a shortcut to putting useful info like the database URI into a variable the app can use.

5. Click on Create and it'll generate a database instance for you on Mongo's system and attach it to the Space you selected. You're done!

You can confirm the results by going to the Space you selected on the left side, choosing Service with should have a (1) next to it and see an mLab Service in there with the name you used and Plan "free".

![Space Services](./nc-space-dev-service-mlab.png)
## Deploying the Nightscout Application
### Installing CF CLI

It's very helpful to have the CLI tools for PWS installed even if you don't use them much. This tool is required during installation and can be useful later.

Here are instructions for [installing the CF CLI](https://docs.run.pivotal.io/cf-cli/install-go-cli.html) tool for Mac, Windows and Linux. Please install it and return here.

You will want to read the first part of the [Getting Started](https://docs.run.pivotal.io/cf-cli/getting-started.html) page as well, on how to `log in` and `cf push` with the CF CLI

Login Example: `cf login -a https://api.run.pivotal.io -u username@mail.com -p password -o Org-Name-You-Used -s development`

Quick test: type `cf help -a` for a list of commands.

### Preparing Your nightscout for PWS
Now we are ready to put a copy of nightscout in the cloud for your use. You will use a command line window to run a few simple commands to get this done. Most of the things nightscout needs are already in a text file you will include with the app when you send it to PWS. This text file is called `manifest.yml` and is a collection of named variables and values nightscout needs as well as a few things PWS can use to properly run the app. The `manifest.yml` file is mostly complete and only needs a little attention from you to get ready.

Want more reading? Here's a [PWS Sample App](https://docs.run.pivotal.io/buildpacks/ruby/sample-ror.html) example.

#### Preparing The Manifest

In your clone of the nighscout site, you will find a `manifest.yml` file. It's a text file with a certain formatting applied. At the very least, you need to supply two things:

`API_SECRET`: a secret password you will keep to administrate nightscout with
<br>
`ENABLE`: a space-separated list of features (plugins) you want nightscout to run. A few common ones are already included. [Look here](https://github.com/nightscout/cgm-remote-monitor#plugins) for a much more complete list.

```
$ cf push -f {path to manifest.yml} --no-start
```

## Changing Nightscout Settings

In PWS, you can view the settings for your app by selecting the app in the Space the app resides in, clicking the app name and then choosing Settings. You will see User Provided Environment Variables about half way down the page. The settings for nightscout are here in Name / Value pairs.

 Here you will find the `ENABLE` variable, which turn on and off many features of the app. These features are well documented in other places, but in short, you'll want at least these:

 `API_SECRET` to set the admin secret for your site.
<br>
 `MONGO_CONNECTION` holds the URI (or path) to the Mongo database.

 If you are using the `BRIDGE` feature, you'll also have:

 `BRIDGE_USER_NAME` is the username in Dexcom Share site.
 <br>
 `BRIDGE_PASSWORD` is the password for the above user name.

## Using nightscout on PWS

Once your app is running and connected to the database, you can browse to the web view by following the Routes attached to the app. By default there will be one, the same as what you named the app. The easist way to find this is to log in to PWS, click on the Space the app is in and click on the route highlighted next to it. This will open a new window with nightscout in setup mode.

Note that there is *No Reason* to run a keep-alive app the pings nightscout to keep it going. That's a shortcoming of other cloud environments such as Heroku. PWS runs apps 24x7 without interruption or quotas.

## Interesting PWS Features To Check out
In Setting for the app, you can change the app name. You can also delete the app in Settings.

In Overview, you can see the app's history and how long the app has been up, what it's consuming and there's a handy link to PCF Metric, where you can see graphs of the apps activity.

The Logs tab will let you easily tail the logs for the app if you want to see what it's up to. Note the "play button on the upper right corner to turn on the tail feature.
