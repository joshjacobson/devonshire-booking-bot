'use strict';

const {
  generateCandidateTimes,
  pickEarliestAvailable,
  splitName,
} = require('./slots');

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
  const p = new URLSearchParams({
    ...VENUE.params,
    num_people: String(numPeople),
    date,
    time,
  });
  return `${VENUE.base}?${p.toString()}`;
}

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read availability signals from the currently-loaded /book page. */
async function readPageSignals(page) {
  return page.evaluate(() => {
    const btns = [...document.querySelectorAll('button,a')];
    const bookNow = btns.find(
      (b) => b.type === 'submit' && /^\s*book now\s*$/i.test((b.textContent || ''))
    ) || btns.find((b) => /^\s*book now\s*$/i.test((b.textContent || '')));
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

/** Read a confirmation result from the page after submitting. */
async function readConfirmation(page) {
  return page.evaluate(() => {
    const text = (document.body.innerText || '').replace(/\s+/g, ' ');
    const confirmed =
      /booking is confirmed|your booking is confirmed|booking confirmed|thank you|we look forward to|see you|confirmation/i.test(
        text
      );
    const refMatch = text.match(/(?:reference|ref|booking)\D{0,12}([A-Z0-9]{5,})/i);
    return {
      confirmed,
      reference: refMatch ? refMatch[1] : null,
      url: location.href,
      snippet: text.slice(0, 300),
    };
  });
}

/**
 * Attempt one date+time. Returns:
 *   {status:'booked', reference, time}
 *   {status:'enquiry-only'|'unavailable'|'unknown', time}
 *   {status:'error', error, time}
 */
async function attemptBooking(context, { date, time, numPeople, name, email, phone, dryRun }) {
  const page = await context.newPage();
  try {
    const url = buildBookUrl({ date, time, numPeople });
    // NOTE: do NOT use waitUntil:'networkidle' — DesignMyNight keeps analytics
    // sockets open so it never goes idle (45s hangs + stale reads).
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    // Wait until the Angular widget resolves to a definite state.
    await page
      .waitForFunction(
        () => {
          const t = document.body.innerText || '';
          const hasForm = !!document.querySelector('#email');
          const enq = /booking enquiry|unable to automatically confirm/i.test(t);
          const none = /no availability|fully booked|no longer available|sold out/i.test(t);
          return hasForm || enq || none;
        },
        { timeout: 20000 }
      )
      .catch(() => {});
    await sleep(400);

    const sig = await readPageSignals(page);
    if (!sig.hasBookNow || sig.isEnquiry) {
      return { status: sig.isEnquiry ? 'enquiry-only' : 'unavailable', time, sig };
    }

    const { firstName, lastName } = splitName(name);
    await page.fill('#email', email);
    await page.fill('#first_name', firstName);
    await page.fill('#last_name', lastName);
    await page.fill('#phone', phone);
    // required policy checkbox
    await page.check('#policy_confirm').catch(async () => {
      // fall back to clicking its label if direct check is intercepted
      await page.click('label[for="policy_confirm"]').catch(() => {});
    });

    if (dryRun) {
      log(`[DRY RUN] would submit ${date} ${time} for ${firstName} ${lastName}`);
      return { status: 'dry-run-ready', time, sig };
    }

    // Submit
    const submit = page.locator('button[type=submit]', { hasText: /^\s*Book Now\s*$/i }).first();
    await submit.click({ timeout: 15000 });

    // Wait for navigation / confirmation render
    await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
    await sleep(2500);
    const conf = await readConfirmation(page);
    if (conf.confirmed) {
      return { status: 'booked', reference: conf.reference, time, url: conf.url, snippet: conf.snippet };
    }
    return { status: 'submitted-unconfirmed', time, conf };
  } catch (err) {
    return { status: 'error', time, error: String(err && err.message ? err.message : err) };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Main loop for one night. Waits until releaseAtMs, then probes candidate
 * times every retryMs until one books or stopAtMs passes.
 */
async function run(opts) {
  const {
    date,
    windowStart = '19:00',
    windowEnd = '20:00',
    numPeople = 2,
    name,
    email,
    phone,
    releaseAtMs = Date.now(),
    stopAtMs = Date.now() + 45 * 60 * 1000,
    retryMs = 30000,
    dryRun = false,
    headless = true,
    browserFactory, // injectable for testing
  } = opts;

  const candidates = generateCandidateTimes(windowStart, windowEnd, 15);
  log(`Night ${date}: window ${windowStart}-${windowEnd}, candidates=${candidates.join(',')}, name="${name}", dryRun=${dryRun}`);

  // Wait until release (sleep-until; immune to scheduler launch jitter)
  const waitMs = Math.max(0, releaseAtMs - Date.now());
  if (waitMs > 0) {
    log(`Sleeping ${Math.round(waitMs / 1000)}s until release at ${new Date(releaseAtMs).toISOString()}`);
    await sleep(waitMs);
  }

  const makeBrowser = browserFactory || (async () => {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 900 },
      locale: 'en-GB',
    });
    return { browser, context };
  });

  const { browser, context } = await makeBrowser();
  try {
    let attempt = 0;
    while (Date.now() < stopAtMs) {
      attempt += 1;
      for (const time of candidates) {
        const res = await attemptBooking(context, { date, time, numPeople, name, email, phone, dryRun });
        log(`  attempt#${attempt} ${date} ${time} -> ${res.status}${res.reference ? ' ref=' + res.reference : ''}`);
        if (res.status === 'booked') {
          log(`✅ BOOKED ${date} ${time} for "${name}" ref=${res.reference || '(none shown)'}`);
          return { ok: true, date, time, reference: res.reference || null, name };
        }
        if (res.status === 'dry-run-ready') {
          return { ok: true, dryRun: true, date, time, name };
        }
        if (res.status === 'submitted-unconfirmed') {
          // Submitted but couldn't verify text — treat as likely success, surface for manual check
          log(`⚠️ ${date} ${time} submitted but confirmation text not detected; verify email.`);
          return { ok: true, unconfirmed: true, date, time, name, detail: res.conf };
        }
      }
      if (Date.now() + retryMs >= stopAtMs) break;
      await sleep(retryMs);
    }
    log(`❌ Gave up on ${date} (no instant 7-8pm slot before stop time).`);
    return { ok: false, date, name };
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

async function mainFromEnvAndArgs() {
  const a = parseArgs(process.argv);
  const env = process.env;
  const opts = {
    date: a.date || env.BOOK_DATE,
    windowStart: a['window-start'] || env.WINDOW_START || '19:00',
    windowEnd: a['window-end'] || env.WINDOW_END || '20:00',
    numPeople: Number(a.people || env.NUM_PEOPLE || 2),
    name: a.name || env.BOOK_NAME,
    email: a.email || env.BOOK_EMAIL,
    phone: a.phone || env.BOOK_PHONE,
    releaseAtMs: a['release-at'] || env.RELEASE_AT ? Date.parse(a['release-at'] || env.RELEASE_AT) : Date.now(),
    stopAtMs:
      a['stop-at'] || env.STOP_AT
        ? Date.parse(a['stop-at'] || env.STOP_AT)
        : Date.now() + 45 * 60 * 1000,
    retryMs: Number(a['retry-ms'] || env.RETRY_MS || 30000),
    dryRun: (a['dry-run'] || env.DRY_RUN) === 'true',
    headless: (a.headless || env.HEADLESS || 'true') !== 'false',
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
  readPageSignals,
  readConfirmation,
  attemptBooking,
  run,
  parseArgs,
};

if (require.main === module) {
  mainFromEnvAndArgs();
}
