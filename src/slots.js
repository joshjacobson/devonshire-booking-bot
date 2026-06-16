'use strict';

// ---- Pure, unit-testable helpers (no browser, no I/O) ----

/** "19:15" -> 1155 (minutes since midnight). Throws on bad input. */
function timeToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) throw new Error(`bad time: ${hhmm}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) throw new Error(`out of range: ${hhmm}`);
  return h * 60 + min;
}

/** 1155 -> "19:15" (zero-padded HH:MM). */
function minutesToTime(total) {
  const t = ((total % 1440) + 1440) % 1440;
  const h = Math.floor(t / 60);
  const m = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * All candidate slot start-times in [startHHMM, endHHMM] inclusive, every stepMin.
 * generateCandidateTimes("19:00","20:00") -> ["19:00","19:15","19:30","19:45","20:00"]
 */
function generateCandidateTimes(startHHMM, endHHMM, stepMin = 15) {
  const start = timeToMinutes(startHHMM);
  const end = timeToMinutes(endHHMM);
  if (end < start) throw new Error('end before start');
  if (stepMin <= 0) throw new Error('stepMin must be > 0');
  const out = [];
  for (let t = start; t <= end; t += stepMin) out.push(minutesToTime(t));
  return out;
}

/** True if hhmm is within [startHHMM, endHHMM] inclusive. */
function isInWindow(hhmm, startHHMM, endHHMM) {
  const t = timeToMinutes(hhmm);
  return t >= timeToMinutes(startHHMM) && t <= timeToMinutes(endHHMM);
}

/**
 * Given the set of times the venue reports as available, return the earliest
 * one that is also a candidate (in-window). Null if none overlap.
 */
function pickEarliestAvailable(availableTimes, candidateTimes) {
  const avail = new Set(availableTimes.map((t) => normalizeTime(t)));
  for (const c of [...candidateTimes].sort((a, b) => timeToMinutes(a) - timeToMinutes(b))) {
    if (avail.has(normalizeTime(c))) return normalizeTime(c);
  }
  return null;
}

/** Accepts "9:00", "09:00", "7:00pm" -> canonical "HH:MM" (24h). */
function normalizeTime(s) {
  const str = String(s).trim().toLowerCase();
  const ampm = /^(\d{1,2}):(\d{2})\s*(am|pm)$/.exec(str);
  if (ampm) {
    let h = Number(ampm[1]) % 12;
    if (ampm[3] === 'pm') h += 12;
    return minutesToTime(h * 60 + Number(ampm[2]));
  }
  return minutesToTime(timeToMinutes(str));
}

/** ms to wait until target epoch ms; never negative. */
function msUntil(targetEpochMs, nowMs) {
  return Math.max(0, targetEpochMs - nowMs);
}

/** "Ada Lovelace" -> {firstName:"Ada", lastName:"Lovelace"}. Single token -> lastName "". */
function splitName(full) {
  const parts = String(full).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * Classify a /book page from observable signals.
 * Returns 'bookable' | 'enquiry' | 'unknown'.
 */
function classifyBookingPage({ hasBookNow, isEnquiry, hasEmailField }) {
  if (hasBookNow && !isEnquiry) return 'bookable';
  if (isEnquiry || (hasEmailField && !hasBookNow)) return 'enquiry';
  return 'unknown';
}

module.exports = {
  timeToMinutes,
  minutesToTime,
  generateCandidateTimes,
  isInWindow,
  pickEarliestAvailable,
  normalizeTime,
  msUntil,
  splitName,
  classifyBookingPage,
};
