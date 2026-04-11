# RailRadar — Train Intelligence

**Live seat availability, confirmation probability, PNR status, split journeys, waitlist tracker, and Gemini AI advice for Indian Railways.**

Built with vanilla HTML/CSS/JS. Uses RapidAPI (IRCTC) and optional Google Gemini 2.0 Flash.

##  Features

-  Find Trains – real-time availability across General, Tatkal, Premium Tatkal quotas with confirmation probability.
-  Route Planner – direct, alternate origin, longer‑segment GNWL upgrade, and split journeys via interchange hubs.
-  Split Journey Finder – turn PQWL/RLWL into GNWL or two‑PNR combos.
-  PNR Status – live status with passenger‑level probability and movement tracking.
-  Waitlist Tracker – visual WL position over time with movement chart.
-  Gemini AI Advisor – context‑aware tips for each booking situation (optional).
-  Confirmation Predictor – statistical model for GNWL, PQWL, RLWL, TQWL, RQWL.

##  Tech Stack

- HTML5 / CSS3 / Vanilla JavaScript
- RapidAPI – IRCTC API (required)
- Google Gemini 2.0 Flash (optional)
- Fonts: DM Mono, Fraunces, DM Sans

##  Environment Variables

Create a '.env' file (or set on Railway) with:
```
    RAPIDAPI_KEY=your_rapidapi_key_here
    GEMINI_API_KEY=your_gemini_api_key_here   # optional
```
- 'RAPIDAPI_KEY' – required for live IRCTC data. Get it from [RapidAPI](https://rapidapi.com/irctc1/api/irctc1).
- 'GEMINI_API_KEY' – optional, enables AI advice. Get it from [Google AI Studio](https://aistudio.google.com/).

##  Local Development

1. Clone the repository.
2. Create 'config.js' in the root folder:
```
        window.RAILRADAR_CONFIG = {
          RAPIDAPI_KEY: "your_key",
          GEMINI_API_KEY: "your_key"
        };
```
3. Open 'index.html' in a browser (no build step needed).

## Deploy to Railway

### 1. Add two files to your repository

**generate-config.js** – injects environment variables at build time:

    const fs = require('fs');
    const rapidapiKey = process.env.RAPIDAPI_KEY || '';
    const geminiKey = process.env.GEMINI_API_KEY || '';
    const configContent = 'window.RAILRADAR_CONFIG = {\n  RAPIDAPI_KEY: "' + rapidapiKey + '",\n  GEMINI_API_KEY: "' + geminiKey + '"\n};';
    fs.writeFileSync('config.js', configContent);
    console.log(' config.js generated');

**railway.json** – tells Railway how to build and run:

    {
      "build": {
        "builder": "NIXPACKS",
        "buildCommand": "node generate-config.js"
      },
      "deploy": {
        "startCommand": "npx serve .",
        "restartPolicyType": "ON_FAILURE"
      }
    }

### 2. Commit and push

    git add generate-config.js railway.json
    git commit -m "Add Railway build files"
    git push origin main

### 3. Deploy on Railway

- Go to [Railway.app](https://railway.app) → New Project → Deploy from GitHub repo.
- Select your repository.
- Railway will automatically run 'node generate-config.js' and then 'npx serve .'.

### 4. Add environment variables

- In your Railway project dashboard, go to the **Variables** tab.
- Add 'RAPIDAPI_KEY' (required) and optionally 'GEMINI_API_KEY'.
- Railway will redeploy automatically.

### 5. Open your live URL

Railway provides a URL like 'https://railradar.up.railway.app'. The app should work with live IRCTC data.

## Verify Deployment

- Sidebar shows '● Live — IRCTC data active' (green) if the API key is valid.
- Search for a route (e.g., 'SC' → 'MAS') and pick a future date.
- Results should appear with availability chips.
