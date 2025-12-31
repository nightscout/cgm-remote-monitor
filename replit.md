# Nightscout CGM Remote Monitor

## Overview
Nightscout is a web-based CGM (Continuous Glucose Monitor) system allowing caregivers to remotely view a patient's glucose data in realtime. This is version 15.0.4 of the cgm-remote-monitor project.

## Current State
- Project is set up and running on Replit
- MongoDB is configured locally for development
- Server runs on port 5000 with host 0.0.0.0
- Webpack bundling for frontend assets

## Project Structure
- `lib/server/server.js` - Main application entry point
- `lib/server/app.js` - Express application setup
- `lib/server/env.js` - Environment configuration
- `lib/api/` - REST API v1 endpoints
- `lib/api2/` - REST API v2 endpoints
- `lib/api3/` - REST API v3 endpoints
- `lib/plugins/` - Nightscout plugins (ar2, basal, bolus, etc.)
- `lib/storage/` - MongoDB storage adapters
- `lib/client/` - Client-side code
- `static/` - Static files (HTML, CSS, frontend assets)
- `bundle/` - Webpack bundle source files
- `webpack/` - Webpack configuration
- `start.sh` - Startup script that launches MongoDB and the app

## Environment Variables
- `PORT` - Server port (set to 5000)
- `HOSTNAME` - Bind address (set to 0.0.0.0)
- `MONGO_CONNECTION` - MongoDB connection string
- `API_SECRET` - API authentication secret (minimum 12 characters)
- `INSECURE_USE_HTTP` - Set to true for Replit proxy compatibility

## Running the Project
The workflow automatically:
1. Starts MongoDB with data stored in `/home/runner/data/db`
2. Launches the Node.js server on port 5000

## NPM Scripts
- `npm start` - Start production server
- `npm run bundle` - Build webpack bundles
- `npm run dev` - Start development server with nodemon
- `npm test` - Run tests

## Recent Changes
- 2025-12-31: Updated to version 15.0.4 (dev branch)
- Configured for Replit environment with INSECURE_USE_HTTP=true
- Uses MongoDB 3.6.x driver
- Webpack bundling for frontend assets
