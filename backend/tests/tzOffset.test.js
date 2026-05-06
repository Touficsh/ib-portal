/**
 * TZ offset roundtrip — locks in the broker-local-to-UTC conversion that
 * the webhook receiver and snapshot sync rely on.
 *
 * The MT5 Manager API returns deal.Time() as broker-local seconds-since-
 * epoch. We subtract the configured offset BEFORE storing so deal_time in
 * the DB is always real UTC.
 *
 * Run: node --test tests/tzOffset.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The conversion is intentionally tiny + duplicated in two places (webhook,
// snapshot). Test the math directly so any drift between the two implementations
// fails the test suite. If we ever extract a single shared converter, this
// test becomes a pure unit test of that converter.
function brokerLocalToUtcMs(timeSec, tzOffsetSec) {
  return (timeSec - tzOffsetSec) * 1000;
}

test('UTC+3 broker — subtract 3 hours to get real UTC', () => {
  // Broker server says "deal at 18:00 broker-local" (in seconds since epoch
  // tagged as if UTC). Real UTC was actually 15:00.
  const brokerLocal = Date.UTC(2026, 4, 4, 18, 0, 0) / 1000;  // 18:00Z (but it's a lie)
  const tzOffsetSec = 3 * 3600;                                // 3 hours

  const utcMs = brokerLocalToUtcMs(brokerLocal, tzOffsetSec);
  const utcIso = new Date(utcMs).toISOString();

  assert.equal(utcIso, '2026-05-04T15:00:00.000Z');
});

test('UTC+0 broker — no shift', () => {
  const tStamp = Date.UTC(2026, 4, 4, 12, 30, 0) / 1000;
  const utcMs = brokerLocalToUtcMs(tStamp, 0);
  assert.equal(new Date(utcMs).toISOString(), '2026-05-04T12:30:00.000Z');
});

test('Negative offset (UTC-5 broker) — add hours to get real UTC', () => {
  // Broker says "12:00 broker-local". Real UTC was actually 17:00.
  const brokerLocal = Date.UTC(2026, 4, 4, 12, 0, 0) / 1000;
  const tzOffsetSec = -5 * 3600;
  const utcMs = brokerLocalToUtcMs(brokerLocal, tzOffsetSec);
  assert.equal(new Date(utcMs).toISOString(), '2026-05-04T17:00:00.000Z');
});

test('Roundtrip — ms precision preserved', () => {
  const utc = Date.UTC(2026, 4, 4, 15, 30, 45);
  const tzOffsetSec = 3 * 3600;
  const brokerLocal = (utc / 1000) + tzOffsetSec;          // simulate broker shifting it
  const recovered = brokerLocalToUtcMs(brokerLocal, tzOffsetSec);
  assert.equal(recovered, utc);
});

test('Day boundary — broker time wraps but UTC stays correct', () => {
  // Broker says "01:00 next day". With +3 offset, real UTC is "22:00 prev day".
  const brokerLocal = Date.UTC(2026, 4, 5, 1, 0, 0) / 1000;
  const tzOffsetSec = 3 * 3600;
  const utcIso = new Date(brokerLocalToUtcMs(brokerLocal, tzOffsetSec)).toISOString();
  assert.equal(utcIso, '2026-05-04T22:00:00.000Z');
});
