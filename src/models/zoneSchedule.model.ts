/** How the zone repeats within its operation date range. */
export type SchedulePattern = "daily" | "weekly" | "monthly";

export const SCHEDULE_PATTERNS = ["daily", "weekly", "monthly"] as const;

/** 0 = Sunday … 6 = Saturday (matches `Date.getDay()`). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
