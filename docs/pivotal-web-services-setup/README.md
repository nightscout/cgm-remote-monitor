# Deploying Nightscout onto Pivotal Web Services

Pivotal Web Services (PWS) is a public cloud platform offered by [Pivotal Software, Inc](http://pivotal.io).

## Forking the Repo
## Installing CF CLI
## Creating an account
## Target your Org and Space
## Create mLab MongoDB Service

PWS makes it really easy to get outside services for use with your apps. For nightscout, the app requires a database, which we get from MongoDB, who happens to be a member of the PWS Marketplace, among many others.

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

(((Instructions for how to do it via the CLI?)))

## Changing Nightscout Settings

In PWS, you can view the settings for your app by selecting the app in the Space the app resides in, clicking the app name and then choosing Settings. You will see User Provided Environment Variables about half way down the page. The settings for nightscout are here in Name / Value pairs.

 Here you will find the `ENABLE` variable, which turn on and off many features of the app. These features are well documented in other places, but in short, you'll want at least these:

 `API_SECRET` to set the admin secret for your site.

 `MONGO_CONNECTION` holds the URI (or path) to the Mongo database.

 If you are using the `BRIDGE` feature, you'll also have:

 `BRIDGE_USER_NAME` is the username in Dexcom Share site.
 `BRIDGE_PASSWORD` is the password for the above user name.

## Deploying the Nightscout Application
```
$ cf push -f {path to manifest.yml}
```
## Using nightscout on PWS

Once your app is running and connected to the database, you can browse to the web view by following the Routes attached to the app. By default there will be one, the same as what you named the app. The easist way to find this is to log in to PWS, click on the Space the app is in and click on the route highlighted next to it. This will open a new window with nightscout in setup mode.

## Interesting PWS Features To Check out
In Setting for the app, you can change the app name. You can also delete the app in Settings.

In Overview, you can see the app's history and how long the app has been up, what it's consuming and there's a handy link to PCF Metric, where you can see graphs of the apps activity.

The Logs tab will let you easily tail the logs for the app if you want to see what it's up to. Note the "play button on the upper right corner to turn on the tail feature.
