# DiDa Macros

A personal, phone-friendly macro tracker hosted on GitHub Pages. Snap a photo of your food, get an AI estimate of calories, protein, carbs and fat, adjust it, and log it against your daily targets.

Live site: https://mountrobson.github.io/dida-macro-factor/

## Features

- **Photo logging**: take a photo (or pick one from your library), optionally add a note ("cooked in butter"), and an AI (Google Gemini on its free tier by default, or Anthropic Claude if you prefer to pay) estimates each item and the totals. Every number is editable before you save, and there are quick portion buttons (½× to 2×).
- **Manual entry** with one-tap re-logging of recent foods.
- **Daily dashboard**: calories left, protein/carb/fat bars, entries grouped by meal, and day-by-day navigation.
- **Targets**: set them yourself or have them calculated from age, height, weight, activity and goal.
- **Progress**: daily weigh-ins with a smoothed weight trend, 7/30-day trend change, and a 7-day intake table.
- **Backup**: export and import your data as a JSON file.
- Installable to the home screen and works offline (except photo estimates).

## Privacy

- There is no server. Foods, weigh-ins, thumbnails and settings are stored only in the browser on your phone (IndexedDB and localStorage). Nothing is ever committed to this repo.
- Photo estimates are sent straight from your phone to Google Gemini (or Anthropic, if you pick Claude) using **your own API key**, which you paste into Settings. The key stays on your device and is not in the code. On the free Gemini tier Google may use and review what you send to improve its products.

## Setup on your phone

1. Get a free Gemini API key at https://aistudio.google.com (Get API key). No credit card is needed. A free key is never charged: when the daily limit runs out, estimates pause until the next day (the app falls back to Flash-Lite, which has a bigger daily allowance, first).
2. Open the live site on your phone.
3. Go to **Settings**, paste the key, tap **Test key**, and set your daily targets.
4. Add it to your home screen: Safari Share button, then **Add to Home Screen** (on Android Chrome: menu, then **Add to Home screen**).

Note: data lives in the browser you use. On iPhone the home-screen app and Safari keep separate data, so pick one and stick with it, and export a backup now and then.

## Files

`index.html`, `styles.css`, `app.js` (all app logic), `sw.js` (offline cache), `manifest.webmanifest` and the icons. No build step.
