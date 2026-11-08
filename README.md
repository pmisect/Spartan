# Spartan Race Tracker

A personal performance tracker for Spartan races. It's a small static website with no server, no accounts and no build step, and it's kept separate from any business systems.

## What it does

- **Dashboard**: races finished, distance, obstacle success rate, best finish percentile, penalty burpees, a season goal, a countdown to the next race, **Trifecta tracker** (Sprint + Super + Beast in one year), personal records by race type, charts for pace and finish ranking, most-failed obstacles, and badges.
- **My Races**: log finished races (time, distance, placings, obstacles, burpees, failed obstacles, notes) or races he's planning to run.
- **Race Map**: every race he's done (★) or planned (⚑), his home (⌂), and optionally all upcoming Spartan events.
- **Find Races**: upcoming Spartan events filtered by distance from home, race type (including Kids), or full Trifecta weekends, with a one-tap "Add to plan" and links to register on spartan.com.
- **Profile & Backup**: name, birth year, home town, season goal, and backup/restore.

## Where the data lives

Race data is saved **only in the browser** (localStorage) of the device being used. Nothing is uploaded. To move it to another device, use **Profile & Backup → Download backup**, then **Restore backup** on the other device. Download a backup now and then in case the browser data gets cleared.

The site sends requests to only three outside services: the CDN (cdnjs) for the Leaflet and Chart.js libraries, OpenStreetMap for map tiles, and Nominatim (OpenStreetMap) when you tap "Look up" or "Find on map" for a town name.

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
