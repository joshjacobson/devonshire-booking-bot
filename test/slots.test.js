'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  timeToMinutes,
  minutesToTime,
  generateCandidateTimes,
  isInWindow,
  pickEarliestAvailable,
  normalizeTime,
  msUntil,
  splitName,
  classifyBookingPage,
} = require('../src/slots');

const { buildBookUrl, parseArgs, createBudget, parseNights } = require('../src/book');

test('timeToMinutes parses HH:MM', () => {
  assert.equal(timeToMinutes('19:15'), 1155);
  assert.equal(timeToMinutes('00:00'), 0);
  assert.equal(timeToMinutes('9:05'), 545);
});

test('timeToMinutes rejects garbage', () => {
  assert.throws(() => timeToMinutes('nope'));
  assert.throws(() => timeToMinutes('25:00'));
  assert.throws(() => timeToMinutes('12:99'));
});

test('minutesToTime zero-pads and wraps', () => {
  assert.equal(minutesToTime(1155), '19:15');
  assert.equal(minutesToTime(5), '00:05');
  assert.equal(minutesToTime(1440), '00:00');
});

test('generateCandidateTimes covers the 7-8pm window inclusive', () => {
  assert.deepEqual(generateCandidateTimes('19:00', '20:00', 15), [
    '19:00',
    '19:15',
    '19:30',
    '19:45',
    '20:00',
  ]);
});

test('generateCandidateTimes single point and custom step', () => {
  assert.deepEqual(generateCandidateTimes('19:00', '19:00', 15), ['19:00']);
  assert.deepEqual(generateCandidateTimes('19:00', '20:00', 30), ['19:00', '19:30', '20:00']);
  assert.throws(() => generateCandidateTimes('20:00', '19:00', 15));
});

test('isInWindow inclusive bounds', () => {
  assert.equal(isInWindow('19:00', '19:00', '20:00'), true);
  assert.equal(isInWindow('20:00', '19:00', '20:00'), true);
  assert.equal(isInWindow('20:01', '19:00', '20:00'), false);
  assert.equal(isInWindow('18:59', '19:00', '20:00'), false);
});

test('normalizeTime handles am/pm and bare 24h', () => {
  assert.equal(normalizeTime('7:00pm'), '19:00');
  assert.equal(normalizeTime('7:30PM'), '19:30');
  assert.equal(normalizeTime('12:00am'), '00:00');
  assert.equal(normalizeTime('12:00pm'), '12:00');
  assert.equal(normalizeTime('9:05'), '09:05');
});

test('pickEarliestAvailable returns earliest in-window overlap', () => {
  const candidates = generateCandidateTimes('19:00', '20:00', 15);
  assert.equal(pickEarliestAvailable(['20:00', '19:30', '21:00'], candidates), '19:30');
  assert.equal(pickEarliestAvailable(['7:00pm', '8:00pm'], candidates), '19:00');
  assert.equal(pickEarliestAvailable(['21:00', '21:30'], candidates), null);
  assert.equal(pickEarliestAvailable([], candidates), null);
});

test('msUntil never negative', () => {
  assert.equal(msUntil(1000, 500), 500);
  assert.equal(msUntil(500, 1000), 0);
  assert.equal(msUntil(1000, 1000), 0);
});

test('splitName splits first/last correctly, incl. short first names', () => {
  assert.deepEqual(splitName('Ada Lovelace'), { firstName: 'Ada', lastName: 'Lovelace' });
  assert.deepEqual(splitName('Grace Hopper'), { firstName: 'Grace', lastName: 'Hopper' });
  assert.deepEqual(splitName('BB King'), { firstName: 'BB', lastName: 'King' });
  assert.deepEqual(splitName('Cher'), { firstName: 'Cher', lastName: '' });
  assert.deepEqual(splitName('  Mary  Jane  Watson '), {
    firstName: 'Mary',
    lastName: 'Jane Watson',
  });
});

test('classifyBookingPage distinguishes bookable vs enquiry', () => {
  assert.equal(
    classifyBookingPage({ hasBookNow: true, isEnquiry: false, hasEmailField: true }),
    'bookable'
  );
  assert.equal(
    classifyBookingPage({ hasBookNow: false, isEnquiry: true, hasEmailField: true }),
    'enquiry'
  );
  assert.equal(
    classifyBookingPage({ hasBookNow: false, isEnquiry: false, hasEmailField: true }),
    'enquiry'
  );
  assert.equal(
    classifyBookingPage({ hasBookNow: false, isEnquiry: false, hasEmailField: false }),
    'unknown'
  );
});

test('buildBookUrl encodes the verified Devonshire/Dinner params', () => {
  const url = buildBookUrl({ date: '2026-07-12', time: '19:00', numPeople: 2 });
  assert.match(url, /^https:\/\/bookings\.designmynight\.com\/book\?/);
  assert.match(url, /venue_id=64ba4dc01a788a0a0523a9fa/);
  assert.match(url, /type=64f1ac8bc00e4863bb3996ea/); // Dinner
  assert.match(url, /num_people=2/);
  assert.match(url, /date=2026-07-12/);
  assert.match(url, /time=19%3A00/);
  assert.match(url, /duration=120/);
});

test('createBudget caps total commits and never books more than max', () => {
  const b = createBudget(2);
  assert.equal(b.isFull(), false);
  // two concurrent submits both acquire
  assert.equal(b.tryAcquire(), true);
  assert.equal(b.tryAcquire(), true);
  assert.equal(b.tryAcquire(), false); // no tokens left while 2 in flight
  // one fails and returns its token
  b.release();
  assert.equal(b.tryAcquire(), true); // freed slot reusable
  // commit the two that succeed
  b.commit();
  assert.equal(b.isFull(), false);
  b.commit();
  assert.equal(b.isFull(), true); // 2 committed = cap reached
  assert.equal(b.committed, 2);
  assert.equal(b.tryAcquire(), false); // nothing more once full
});

test('createBudget(Infinity) never blocks (single-night mode)', () => {
  const b = createBudget(Infinity);
  for (let i = 0; i < 5; i++) assert.equal(b.tryAcquire(), true);
  assert.equal(b.isFull(), false);
});

test('parseNights maps nights to env name/email/phone', () => {
  const env = {
    BOOK_NAME_12: 'A One', BOOK_EMAIL_12: 'a@x.com', BOOK_PHONE_12: '+11',
    BOOK_NAME_13: 'B Two', BOOK_EMAIL_13: 'b@x.com', BOOK_PHONE_13: '+12',
  };
  const nights = parseNights('12:2026-07-12, 13:2026-07-13', env);
  assert.equal(nights.length, 2);
  assert.deepEqual(nights[0], { night: '12', date: '2026-07-12', name: 'A One', email: 'a@x.com', phone: '+11' });
  assert.equal(nights[1].date, '2026-07-13');
  assert.equal(nights[1].email, 'b@x.com');
});

test('parseArgs reads --flags with values and bare booleans', () => {
  const a = parseArgs([
    'node', 'book.js',
    '--date', '2026-07-12',
    '--name', 'Ada Lovelace',
    '--dry-run',
  ]);
  assert.equal(a.date, '2026-07-12');
  assert.equal(a.name, 'Ada Lovelace');
  assert.equal(a['dry-run'], 'true');
});
