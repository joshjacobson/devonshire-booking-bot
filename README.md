# devonshire-booking

A small Playwright bot that books a table at **The Devonshire** (Soho, London) the
moment its à‑la‑carte tables are released, since the dining room opens bookings in
weekly tranches on Thursdays at 10:30 London time and the good slots go fast.

## How it works
- The Devonshire books through **DesignMyNight**. The booking form is a plain page
  driven entirely by URL params (`date`, `time`, `num_people`, venue/type IDs), so
  the bot navigates straight to it — no brittle click‑through.
- A slot is **instantly confirmable** when the page shows a real **"Book Now"**
  button and is *not* an "enquiry"; the bot only books those (an enquiry is a
  request, not a guaranteed table).
- It runs on **GitHub Actions** (one matrix job per target night) so it works even
  when no personal machine is on. Each job **sleeps until just before the release
  time**, then probes the desired time window every 30s until a slot confirms.

## Configuration (all via repo secrets / Actions inputs — never in code)
- `BOOK_EMAIL`, `BOOK_PHONE` — contact details used on the booking.
- `BOOK_NAME_<night>` — name per target night.

## Layout
- `src/slots.js` — pure helpers (time windows, slot selection, name split) — unit‑tested.
- `src/book.js` — the Playwright booking flow + retry loop + CLI.
- `test/` — unit tests (`npm test`).
- `.github/workflows/book.yml` — scheduled live run (static matrix per night).
- `.github/workflows/test-book.yml` — manual, **dry‑run by default** (fills the form,
  never submits) — used to verify the runner can reach the site.

## Run locally
```
npm install && npx playwright install chromium
npm test
node src/book.js --date 2026-07-12 --name "..." --email "..." --phone "..." \
  --window-start 19:00 --window-end 20:00 --dry-run true
```
