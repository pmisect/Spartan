# Spartan Race Tracker

A personal performance tracker for Spartan races. It's a small static website with no server, no accounts and no build step, and it's kept separate from any business systems.

## What it does

- **Dashboard**: races finished, distance, obstacle success rate, best finish percentile, penalty burpees, a season goal, a countdown to the next race, **Trifecta tracker** (Sprint + Super + Beast in one year), personal records by race type, charts for pace and finish ranking, most-failed obstacles, and badges.
- **My Races**: log finished races (time, distance, placings, obstacles, burpees, failed obstacles, notes) or races he's planning to run.
- **Race Map**: every race he's done (★) or planned (⚑), his home (⌂), and optionally all upcoming Spartan events.
- **Find Races**: upcoming Spartan events filtered by distance from home, race type (including Kids), or full Trifecta weekends, with a one-tap "Add to plan" and links to register on spartan.com.
- **Profile & Sync**: name, birth year, home town, season goal, backup/restore, and the list of saved suggestions.
- **Photos**: add photos to any race from the phone's camera roll. They're resized and saved on the device, shown in a Race photos gallery on the dashboard and in a full-screen viewer (swipe, save/share), and included in backups when "Include photos" is ticked.
- **Race day**: on the day of a planned race the dashboard shows a race-day banner with a **Log results** button. Planned races whose date has passed show a "How did it go?" reminder.
- **💡 Suggest a change**: a button on every page. Suggestions can be saved on the device, texted or shared through the phone's share menu, or sent as a pre-filled GitHub issue on this repo (labelled `feedback`). To send them somewhere else, change `FEEDBACK_REPO` at the top of `js/app.js`.

## Where the data lives

Races and photos are saved in the browser on each device (localStorage and IndexedDB). With **Family sync** switched on, each phone also keeps a copy in a small Supabase database so every family phone sees the same races, photos and suggestions.

The site sends requests to these outside services only: the CDN (cdnjs) for the Leaflet and Chart.js libraries, OpenStreetMap for map tiles, Nominatim (OpenStreetMap) when you tap "Look up" or "Find on map", and your Supabase project when Family sync is on.

## Family sync (Supabase)

1. Create a free Supabase project.
2. Open **SQL Editor → New query**, paste all of `supabase/setup.sql`, and press **Run**.
3. Put the project URL and the **publishable** key (`sb_publishable_…`) in `js/config.js`. Never put a secret key there.
4. On the phone that has the races: **Profile & Sync → Start family sync**, then **Invite a phone** and send the link to the other phones.

How it's protected: the database tables are locked (row level security on, no grants). The website can only call a few functions, and every call needs the family's long random sync code. That code is only in the invite link, so share it only with family. **Disconnect this phone** stops syncing on one phone, and **Erase data on this device** disconnects first, so the family copy is not affected.

How conflicts are handled: each race keeps the time it was last edited, and the newest edit wins. Deleting a race or photo is passed on to the other phones.

## Updating the race schedule

`data/events.json` holds the upcoming Spartan events used by **Find Races**. It was built from Spartan's published 2027 schedule. Map pins show the **approximate area**, not the exact venue. Spartan adds events during the year, so you can add entries to this file (copy an existing entry and edit it). The **Official race finder** button always links to spartan.com.

## Putting it online (GitHub Pages)

1. Merge this branch into `main`.
2. In the repo, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. The workflow in `.github/workflows/pages.yml` publishes the site on every push to `main`. The address will be `https://<owner>.github.io/<repo>/`.

Note: GitHub Pages on a **private** repository requires a paid GitHub plan. You can also drag the folder onto Netlify Drop or any other static host using a personal (non-business) account.

## Running locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

(Opening `index.html` directly from disk works too, but the race finder needs a local server to load `data/events.json`.)
