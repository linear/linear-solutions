import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateCompletion,
  currentHealth,
  isHealthDowngrade,
  isStalled,
  isTargetDateSlip,
  sevenDayDelta,
  targetDateChangeDays,
} from "../lib/metrics.ts";

test("completion excludes canceled issues from numerator and denominator", () => {
  const result = calculateCompletion([
    { stateType: "completed", estimate: null },
    { stateType: "started", estimate: null },
    { stateType: "canceled", estimate: null },
  ]);
  assert.equal(result.completion, 50);
  assert.equal(result.weightedCompletion, null);
});

test("estimate-weighted completion uses estimated, non-canceled issues", () => {
  const result = calculateCompletion([
    { stateType: "completed", estimate: 8 },
    { stateType: "started", estimate: 2 },
    { stateType: "completed", estimate: null },
    { stateType: "canceled", estimate: 13 },
  ]);
  assert.equal(result.completion, 66.7);
  assert.equal(result.weightedCompletion, 80);
});

test("health is authoritative only while the latest update is fresh", () => {
  const now = new Date("2026-08-25T18:00:00Z");
  assert.equal(currentHealth("onTrack", "2026-08-20T18:00:00Z", now, 7), "onTrack");
  assert.equal(currentHealth("offTrack", "2026-08-17T17:59:59Z", now, 7), "noUpdate");
  assert.equal(currentHealth(null, null, now, 7), "noUpdate");
});

test("health downgrade follows the defined severity transitions", () => {
  assert.equal(isHealthDowngrade("onTrack", "atRisk"), true);
  assert.equal(isHealthDowngrade("onTrack", "offTrack"), true);
  assert.equal(isHealthDowngrade("atRisk", "offTrack"), true);
  assert.equal(isHealthDowngrade("offTrack", "atRisk"), false);
  assert.equal(isHealthDowngrade("noUpdate", "offTrack"), false);
});

test("target date comparison detects slips and reports signed day changes", () => {
  assert.equal(targetDateChangeDays("2026-09-01", "2026-09-08"), 7);
  assert.equal(targetDateChangeDays("2026-09-08", "2026-09-01"), -7);
  assert.equal(isTargetDateSlip("2026-09-01", "2026-09-08"), true);
  assert.equal(isTargetDateSlip("2026-09-08", "2026-09-01"), false);
  assert.equal(isTargetDateSlip(null, "2026-09-01"), false);
});

test("seven-day delta uses the latest snapshot at or before the comparison instant", () => {
  const now = new Date("2026-08-25T12:00:00Z");
  const snapshots = [
    { timestamp: "2026-08-17T12:00:00Z", completion: 42 },
    { timestamp: "2026-08-18T12:00:00Z", completion: 48 },
    { timestamp: "2026-08-20T12:00:00Z", completion: 55 },
  ];
  assert.equal(sevenDayDelta(63, snapshots, now), 15);
});

test("stalled requires two unchanged snapshots inside the full 14-day window", () => {
  const now = new Date("2026-08-25T12:00:00Z");
  assert.equal(isStalled([
    { timestamp: "2026-08-12T12:00:00Z", completion: 60 },
    { timestamp: "2026-08-18T12:00:00Z", completion: 60 },
    { timestamp: "2026-08-25T10:00:00Z", completion: 60 },
  ], now), true);
  assert.equal(isStalled([
    { timestamp: "2026-08-12T12:00:00Z", completion: 60 },
    { timestamp: "2026-08-25T10:00:00Z", completion: 62 },
  ], now), false);
  assert.equal(isStalled([{ timestamp: "2026-08-25T10:00:00Z", completion: 60 }], now), false);
});
