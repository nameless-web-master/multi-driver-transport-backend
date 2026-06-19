import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hasCompleteZoneSchedule,
  isInCircularRange,
  isZoneScheduleActive,
  parseOperationDate,
  parseScheduleFromRow,
} from "./zoneSchedule.service";

const landDaily = {
  transport_mode: "land",
  operation_start_date: "2026-06-01",
  operation_end_date: "2026-06-30",
  schedule_pattern: "daily",
  operating_start_time: "09:00",
  operating_end_time: "17:00",
  departure_time: null,
  arrival_time: null,
};

const landWeekly = {
  ...landDaily,
  schedule_pattern: "weekly",
  weekday_start: 1,
  weekday_end: 5,
};

const landMonthly = {
  ...landDaily,
  schedule_pattern: "monthly",
  month_day_start: 1,
  month_day_end: 15,
};

describe("zoneSchedule", () => {
  it("detects complete schedules", () => {
    assert.equal(hasCompleteZoneSchedule(landDaily), true);
    assert.equal(hasCompleteZoneSchedule(landWeekly), true);
    assert.equal(hasCompleteZoneSchedule(landMonthly), true);
    assert.equal(
      hasCompleteZoneSchedule({ ...landWeekly, weekday_start: null }),
      false
    );
  });

  it("supports circular weekday ranges", () => {
    assert.equal(isInCircularRange(0, 5, 1, 6), true); // Sat in Fri–Mon wrap
    assert.equal(isInCircularRange(3, 1, 5, 6), true); // Wed in Mon–Fri
    assert.equal(isInCircularRange(6, 1, 5, 6), false); // Sat not in Mon–Fri
  });

  it("is active only within date range, day pattern, and time", () => {
    const wednesday = new Date("2026-06-17T10:00:00"); // Wed, mid-month
    const saturday = new Date("2026-06-20T10:00:00");
    const beforeRange = new Date("2026-05-30T10:00:00");
    const afterHours = new Date("2026-06-17T20:00:00");

    assert.equal(isZoneScheduleActive(landDaily, wednesday), true);
    assert.equal(isZoneScheduleActive(landWeekly, wednesday), true);
    assert.equal(isZoneScheduleActive(landWeekly, saturday), false);
    assert.equal(isZoneScheduleActive(landDaily, beforeRange), false);
    assert.equal(isZoneScheduleActive(landDaily, afterHours), false);
  });

  it("is active on matching month days only", () => {
    const day10 = new Date("2026-06-10T10:00:00");
    const day20 = new Date("2026-06-20T10:00:00");
    assert.equal(isZoneScheduleActive(landMonthly, day10), true);
    assert.equal(isZoneScheduleActive(landMonthly, day20), false);
  });

  it("parses node-pg DATE columns (JavaScript Date objects)", () => {
    const pgDate = new Date(2026, 5, 19); // Jun 19 local calendar date
    assert.equal(parseOperationDate(pgDate), "2026-06-19");
    assert.equal(parseOperationDate("2026-06-19"), "2026-06-19");

    const schedule = parseScheduleFromRow({
      operation_start_date: new Date(2026, 5, 19),
      operation_end_date: new Date(2026, 5, 30),
      schedule_pattern: "daily",
      operating_start_time: "09:00",
      operating_end_time: "17:00",
      transport_mode: "land",
    });
    assert.equal(schedule.operation_start_date, "2026-06-19");
    assert.equal(schedule.operation_end_date, "2026-06-30");
  });
});
