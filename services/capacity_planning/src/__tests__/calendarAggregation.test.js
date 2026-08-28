import { describe, expect, it } from 'vitest';
import {
  aggregateMemberBucket,
  buildCalendarBuckets,
  getCoveredWorkingDays,
  getOverlapWorkingDays,
  getPeriodBounds,
} from '../utils/calendarAggregation';

const cycles = [
  {
    id: 'C1',
    name: 'Rider Cycle',
    teamName: 'Rider App',
    startsAt: '2026-02-16T12:00:00',
    endsAt: '2026-02-27T12:00:00',
  },
  {
    id: 'C2',
    name: 'Platform Cycle',
    teamName: 'Platform',
    startsAt: '2026-02-16T12:00:00',
    endsAt: '2026-02-27T12:00:00',
  },
];

const member = {
  id: 'M1',
  name: 'Alex',
  cycles: {
    C1: {
      totalEstimate: 10,
      estimatedIssueCount: 2,
      unestimatedIssueCount: 0,
      byTeam: { T1: { teamName: 'Rider App', estimate: 10 } },
      byProject: {
        P1: { name: 'Checkout', estimate: 10 },
      },
    },
    C2: {
      totalEstimate: 10,
      estimatedIssueCount: 1,
      unestimatedIssueCount: 1,
      byTeam: { T2: { teamName: 'Platform', estimate: 10 } },
      byProject: {
        P2: { name: 'Payments', estimate: 10 },
      },
    },
  },
};

describe('calendar period buckets', () => {
  it('splits a month into clipped calendar weeks', () => {
    const buckets = buildCalendarBuckets(new Date(2026, 1, 1), 'month');

    expect(buckets).toHaveLength(5);
    expect(buckets[0].start.getDate()).toBe(1);
    expect(buckets[0].end.getDate()).toBe(1);
    expect(buckets[1].start.getDate()).toBe(2);
    expect(buckets[1].end.getDate()).toBe(8);
    expect(buckets[4].end.getDate()).toBe(28);
  });

  it('splits a quarter into three month buckets', () => {
    const period = getPeriodBounds(new Date(2026, 4, 10), 'quarter');
    const buckets = buildCalendarBuckets(new Date(2026, 4, 10), 'quarter');

    expect(period.label).toBe('Q2 2026');
    expect(buckets.map((bucket) => bucket.label)).toEqual(['April', 'May', 'June']);
  });
});

describe('working-day overlap', () => {
  it('counts only weekdays shared by a cycle and bucket', () => {
    const bucket = {
      start: new Date(2026, 1, 16),
      end: new Date(2026, 1, 22, 23, 59, 59),
    };

    expect(getOverlapWorkingDays(cycles[0].startsAt, cycles[0].endsAt, bucket.start, bucket.end)).toBe(5);
  });

  it('deduplicates working days covered by concurrent cycles', () => {
    const bucket = {
      start: new Date(2026, 1, 16),
      end: new Date(2026, 1, 22, 23, 59, 59),
    };

    expect(getCoveredWorkingDays(cycles, bucket)).toBe(5);
  });
});

describe('person calendar aggregation', () => {
  const bucket = {
    id: 'week',
    label: 'Feb 16–22',
    start: new Date(2026, 1, 16),
    end: new Date(2026, 1, 22, 23, 59, 59),
  };

  it('combines prorated demand across overlapping team cycles without duplicating supply', () => {
    const result = aggregateMemberBucket({
      member,
      cycles,
      bucket,
      capacityPerCycle: 20,
    });

    // Each 10-day cycle contributes half its demand to this 5-day week:
    // 5 Rider points + 5 Platform points against one 10-point weekly supply.
    expect(result.load).toBe(10);
    expect(result.capacity).toBe(10);
    expect(result.utilization).toBe(100);
    expect(result.teamLoads).toEqual({ 'Rider App': 5, Platform: 5 });
    expect(result.coveredDays).toBe(5);
  });

  it('uses the largest PTO reduction across overlapping cycles instead of double counting it', () => {
    const result = aggregateMemberBucket({
      member,
      cycles,
      bucket,
      capacityPerCycle: 20,
      ptoDays: { M1: { C1: 2, C2: 2 } },
    });

    expect(result.ptoDays).toBe(1);
    expect(result.capacity).toBe(8);
    expect(result.utilization).toBe(125);
  });

  it('filters demand to selected projects', () => {
    const result = aggregateMemberBucket({
      member,
      cycles,
      bucket,
      selectedProjectIds: ['P1'],
      capacityPerCycle: 20,
    });

    expect(result.load).toBe(5);
    expect(result.projectLoads).toEqual({ Checkout: 5 });
  });
});
