'use strict';

const { generateCandidateTimes, splitName } = require('./slots');

// ---- The Devonshire / DesignMyNight constants (verified Jun 2026) ----
const VENUE = {
  base: 'https://bookings.designmynight.com/book',
  params: {
    widget_version: '2',
    venue_id: '64ba4dc01a788a0a0523a9fa',
    venue_group: '64ba4ccd8413f94bc90042a5',
    type: '64f1ac8bc00e4863bb3996ea', // "Dinner"
    duration: '120',
    source: 'partner',
    return_method: 'post',
    locale: 'en-GB',
  },
};

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function buildBookUrl({ date, time, numPeople = 2 }) {
  const p = new URLSearchParams({ ...VENUE.params, num_people: String(numPeople), date, time });
  return `${VENUE.base}?${p.toString()}`;
}

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Shared booking budget. Caps TOTAL successful bookings across all nights.
 * tryAcquire() must be called (synchronously) immediately before a submit so
 * at most `max` submits are ever in flight or committed at once.
 */
/**
 * Should we abandon before even starting? True only when the job launched so
 * long after the intended release that we'd risk a surprise booking. A normal
 * (even multi-hour) GitHub scheduler delay stays well under the limit and runs.
 */
function shouldAbandon(nowMs, releaseAtMs, giveUpAfterMs) {
  return (
    Number.isFinite(releaseAtMs) &&
    Number.isFinite(giveUpAfterMs) &&
    nowMs > releaseAtMs + giveUpAfterMs
  );
}

function createBudget(max) {
  let remaining = max; // tokens available to start a submit
  let committed = 0; // confirmed bookings
  return {
    tryAcquire() {
      if (remaining > 0) {
        remaining -= 1;
        return true;
      }
      return false;
    },
    commit() {
      committed += 1;
    },
    release() {
      remaining += 1;
    },
    isFull() {
      return committed >= max;
    },
    get committed() {
      return committed;
    },
    get remaining() {
      return remaining;
    },
    max,
  };
}

/** Read availability signals from the currently-loaded /book page. */
async function readPageSignals(page) {
  return page.evaluate(() => {
    const btns = [...document.querySelectorAll('button,a')];
    const bookNow =
      btns.find((b) => b.type === 'submit' && /^\s*book now\s*$/i.test(b.textContent || '')) ||
      btns.find((b) => /^\s*book now\s*$/i.test(b.textContent || ''));
    const text = (document.body.innerText || '').replace(/\s+/g, ' ');
    return {
      hasBookNow: !!bookNow,
      isEnquiry: /booking enquiry|unable to automatically confirm/i.test(text),
      hasEmailField: !!document.querySelector('#email, input[name="email"]'),
      header: (text.match(/You are making[^.]*\./) || [''])[0],
      snippet: text.slice(0, 220),
    };
  });
}

/**
 * Read the post-submit page. `confirmed` requires POSITIVE proof of a booking
 * (a DMN-<digits> reference, or an explicit "is now confirmed"). `failed` flags
 * an explicit non-booking (slot sniped / enquiry / error). Neither => ambiguous.
 */
async function readConfirmation(page) {
  return page.evaluate(() => {
    const text = (document.body.innerText || '').replace(/\s+/g, ' ');
    const refMatch = text.match(/(DMN-\d{6,})/i);
    const confirmed =
      !!refMatch || /your booking[^.]*is now confirmed|your booking is confirmed|booking is confirmed/i.test(text);
    const failed =
      /unable to automatically confirm|booking enquiry|no longer available|no availability|not available|sold out|already been booked|fully booked|something went wrong|please try again|could not|couldn'?t|error/i.test(
        text
      );
    return {
      confirmed,
      failed: failed && !confirmed,
      reference: refMatch ? refMatch[1] : null,
      url: location.href,
      snippet: text.slice(0, 300),
    };
  });
}

/**
 * Try one date+time in a fresh page. If `budget` is given, only submits when a
 * slot can be claimed from it. Returns a status object.
 */
async function attemptBooking(context, { date, time, numPeople, name, email, phone, dryRun, budget }) {
  const page = await context.newPage();
  try {
    const url = buildBookUrl({ date, time, numPeople });
    // NOTE: never use waitUntil:'networkidle' — DMN keeps analytics sockets open.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page
      .waitForFunction(
        () => {
          const t = document.body.innerText || '';
          return (
            !!document.querySelector('#email') ||
            /booking enquiry|unable to automatically confirm/i.test(t) ||
            /no availability|fully booked|no longer available|sold out/i.test(t)
          );
        },
        { timeout: 20000 }
      )
      .catch(() => {});
    await sleep(400);

    const sig = await readPageSignals(page);
    if (!sig.hasBookNow || sig.isEnquiry) {
      return { status: sig.isEnquiry ? 'enquiry-only' : 'unavailable', time };
    }

    const { firstName, lastName } = splitName(name);
    await page.fill('#email', email);
    await page.fill('#first_name', firstName);
    await page.fill('#last_name', lastName);
    await page.fill('#phone', phone);
    await page.check('#policy_confirm').catch(async () => {
      await page.click('label[for="policy_confirm"]').catch(() => {});
    });

    if (dryRun) {
      log(`[DRY RUN] would submit ${date} ${time} for ${firstName} ${lastName}`);
      return { status: 'dry-run-ready', time };
    }

    // Global cap: claim a token before submitting. The token is COMMITTED only on
    // positive proof of a booking; on any other outcome it is RELEASED, so a
    // submit that didn't actually book never wastes a cap slot.
    if (budget && !budget.tryAcquire()) {
      return { status: 'skipped-budget', time, submitted: false };
    }
    let holding = !!budget; // hold the token until committed or released (finally)
    let submitted = false;

    try {
      const submit = page.locator('button[type=submit]', { hasText: /^\s*Book Now\s*$/i }).first();
      await submit.click({ timeout: 15000 });
      submitted = true;
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
      await sleep(2500);
      const conf = await readConfirmation(page);
      if (conf.confirmed) {
        if (budget) {
          budget.commit();
          holding = false; // token consumed by a real booking
        }
        return { status: 'booked', reference: conf.reference, time, url: conf.url, submitted };
      }
      // No proof of booking → token released in finally; do NOT count it.
      // 'submit-failed' = explicit non-booking (safe to retry). 'submit-ambiguous'
      // = couldn't tell (rare); caller will stop+flag to avoid a possible double.
      return { status: conf.failed ? 'submit-failed' : 'submit-ambiguous', time, submitted, conf };
    } finally {
      if (holding && budget) budget.release();
    }
  } catch (err) {
    return { status: 'error', time, error: String(err && err.message ? err.message : err) };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Probe one night until it books, the cap fills, or time runs out. */
async function bookOneNight(context, cfg, opts, budget) {
  const { date, name, email, phone } = cfg;
  const {
    windowStart = '19:00',
    windowEnd = '20:00',
    numPeople = 2,
    releaseAtMs = Date.now(),
    runForMs = 90 * 60 * 1000,
    giveUpAfterMs = 24 * 60 * 60 * 1000,
    retryMs = 30000,
    dryRun = false,
  } = opts;
  const candidates = generateCandidateTimes(windowStart, windowEnd, 15);
  log(`Night ${date} ("${name}"): window ${windowStart}-${windowEnd} [${candidates.join(',')}] dryRun=${dryRun}`);

  // Guard: if the job launched FAR past the intended release (e.g. a misfire days
  // later), abandon rather than surprise-book. A normal delay stays under the limit.
  if (shouldAbandon(Date.now(), releaseAtMs, giveUpAfterMs)) {
    log(`⏭️ [${date}] launched ${Math.round((Date.now() - releaseAtMs) / 60000)}min after release (limit ${Math.round(giveUpAfterMs / 60000)}min) — abandoning.`);
    return { ok: false, tooLate: true, date, name };
  }

  const waitMs = Math.max(0, releaseAtMs - Date.now());
  if (waitMs > 0) {
    log(`[${date}] sleeping ${Math.round(waitMs / 1000)}s until ${new Date(releaseAtMs).toISOString()}`);
    await sleep(waitMs);
  }

  // KEY FIX (Jun-18 bug): stop time is RELATIVE to when probing actually starts,
  // computed AFTER the sleep — so a late launch still gets a full probing window
  // instead of finding an already-elapsed absolute stop time and giving up.
  const stopAtMs = Date.now() + runForMs;
  log(`[${date}] probing every ${Math.round(retryMs / 1000)}s until ${new Date(stopAtMs).toISOString()} (${Math.round(runForMs / 60000)}min).`);

  const maxSubmits = Number(opts.maxSubmitsPerNight || 5);
  let attempt = 0;
  let submits = 0; // total Book-Now clicks for this night (backstop vs duplicates)
  let ambiguous = 0; // submits we couldn't classify as booked or clean-miss
  while (Date.now() < stopAtMs) {
    if (budget && budget.isFull()) {
      log(`🛑 [${date}] cap reached elsewhere — stopping "${name}".`);
      return { ok: false, stopped: true, date, name };
    }
    attempt += 1;
    for (const time of candidates) {
      if (budget && budget.isFull()) return { ok: false, stopped: true, date, name };
      if (submits >= maxSubmits) {
        log(`🛑 [${date}] hit submit cap (${maxSubmits}) without confirmation — stopping to avoid duplicates. VERIFY EMAIL.`);
        return { ok: false, needsManualCheck: true, date, name };
      }
      const res = await attemptBooking(context, { date, time, numPeople, name, email, phone, dryRun, budget });
      if (res.submitted) submits += 1;
      log(`  [${date}] attempt#${attempt} ${time} -> ${res.status}${res.reference ? ' ref=' + res.reference : ''}`);
      if (res.status === 'booked') {
        log(`✅ BOOKED ${date} ${time} for "${name}" ref=${res.reference || '(none shown)'}`);
        return { ok: true, date, time, reference: res.reference || null, name };
      }
      if (res.status === 'dry-run-ready') return { ok: true, dryRun: true, date, time, name };
      if (res.status === 'submit-ambiguous') {
        ambiguous += 1;
        log(`⚠️ [${date}] submit AMBIGUOUS (#${ambiguous}); cap slot released. VERIFY EMAIL.`);
        if (ambiguous >= 2) {
          log(`🛑 [${date}] repeated ambiguous submits — stopping to avoid a possible duplicate.`);
          return { ok: false, needsManualCheck: true, date, name };
        }
      }
      // 'submit-failed' (clean miss — slot sniped) / 'unavailable' / 'enquiry-only' /
      // 'skipped-budget' → token already released; keep probing.
    }
    if (Date.now() + retryMs >= stopAtMs) break;
    await sleep(retryMs);
  }
  log(`❌ Gave up on ${date} ("${name}").`);
  return { ok: false, date, name };
}

function defaultBrowserFactory(headless) {
  return async () => {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 900 },
      locale: 'en-GB',
    });
    return { browser, context };
  };
}

/** Single-night run (CLI/testing). No cap. */
async function run(opts) {
  const makeBrowser = opts.browserFactory || defaultBrowserFactory(opts.headless !== false);
  const { browser, context } = await makeBrowser();
  try {
    const budget = createBudget(Infinity);
    return await bookOneNight(
      context,
      { date: opts.date, name: opts.name, email: opts.email, phone: opts.phone },
      opts,
      budget
    );
  } finally {
    await browser.close().catch(() => {});
  }
}

/** All nights concurrently, capped at maxBookings TOTAL. Stops the rest once full. */
async function runAll(opts) {
  const { nights, maxBookings = 2, headless = true } = opts;
  log(`Running ${nights.length} nights concurrently, cap=${maxBookings} total.`);
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless });
  const budget = createBudget(maxBookings);
  try {
    const results = await Promise.all(
      nights.map(async (cfg) => {
        const context = await browser.newContext({
          userAgent: USER_AGENT,
          viewport: { width: 1280, height: 900 },
          locale: 'en-GB',
        });
        try {
          return await bookOneNight(context, cfg, opts, budget);
        } catch (e) {
          return { ok: false, date: cfg.date, name: cfg.name, error: String(e && e.message) };
        } finally {
          await context.close().catch(() => {});
        }
      })
    );
    const booked = results.filter((r) => r && r.ok && !r.dryRun).map((r) => ({ date: r.date, name: r.name, time: r.time }));
    const flagged = results.filter((r) => r && r.needsManualCheck).map((r) => ({ date: r.date, name: r.name }));
    log(`Done. Confirmed ${budget.committed}/${maxBookings}.${flagged.length ? ' ⚠️ VERIFY EMAIL for: ' + flagged.map((f) => f.date).join(', ') : ''}`);
    return { ok: budget.committed > 0, committed: budget.committed, maxBookings, booked, flagged, results };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---- CLI ----
function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      a[key] = val;
    }
  }
  return a;
}

function sharedTiming(a, env) {
  return {
    windowStart: a['window-start'] || env.WINDOW_START || '19:00',
    windowEnd: a['window-end'] || env.WINDOW_END || '20:00',
    numPeople: Number(a.people || env.NUM_PEOPLE || 2),
    releaseAtMs: a['release-at'] || env.RELEASE_AT ? Date.parse(a['release-at'] || env.RELEASE_AT) : Date.now(),
    // Relative probing window (minutes) measured from actual probe start — NOT a
    // fixed clock time. Robust to a late scheduler launch.
    runForMs: Number(a['run-for-min'] || env.RUN_FOR_MIN || 90) * 60 * 1000,
    // Abandon if launched more than this many minutes after release (default 24h).
    giveUpAfterMs: Number(a['give-up-after-min'] || env.GIVE_UP_AFTER_MIN || 1440) * 60 * 1000,
    retryMs: Number(a['retry-ms'] || env.RETRY_MS || 30000),
    dryRun: (a['dry-run'] || env.DRY_RUN) === 'true',
    headless: (a.headless || env.HEADLESS || 'true') !== 'false',
  };
}

/** Parse "12:2026-07-12,13:2026-07-13" + env BOOK_{NAME,EMAIL,PHONE}_<night>. */
function parseNights(spec, env) {
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [night, date] = s.split(':');
      return {
        night,
        date,
        name: env[`BOOK_NAME_${night}`],
        email: env[`BOOK_EMAIL_${night}`],
        phone: env[`BOOK_PHONE_${night}`],
      };
    });
}

async function mainFromEnvAndArgs() {
  const a = parseArgs(process.argv);
  const env = process.env;
  const timing = sharedTiming(a, env);

  if (a.all || env.NIGHTS) {
    const nights = parseNights(a.nights || env.NIGHTS, env);
    const bad = nights.filter((c) => !c.date || !c.name || !c.email || !c.phone);
    if (!nights.length || bad.length) {
      console.error('all-nights mode: missing date/name/email/phone for', bad.map((c) => c.night).join(',') || '(none)');
      process.exit(2);
    }
    const result = await runAll({
      nights,
      maxBookings: Number(a['max-bookings'] || env.MAX_BOOKINGS || 2),
      ...timing,
    });
    console.log('RESULT_JSON ' + JSON.stringify(result));
    process.exit(result.committed > 0 || timing.dryRun ? 0 : 1);
  }

  // Single-night mode
  const opts = {
    date: a.date || env.BOOK_DATE,
    name: a.name || env.BOOK_NAME,
    email: a.email || env.BOOK_EMAIL,
    phone: a.phone || env.BOOK_PHONE,
    ...timing,
  };
  if (!opts.date || !opts.name || !opts.email || !opts.phone) {
    console.error('Missing required: --date --name --email --phone');
    process.exit(2);
  }
  const result = await run(opts);
  console.log('RESULT_JSON ' + JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

module.exports = {
  VENUE,
  buildBookUrl,
  createBudget,
  shouldAbandon,
  readPageSignals,
  readConfirmation,
  attemptBooking,
  bookOneNight,
  run,
  runAll,
  parseArgs,
  parseNights,
};

if (require.main === module) {
  mainFromEnvAndArgs();
}
