import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBulkScheduleDates } from "./bulkScheduleDates";

const rows = ["a", "b", "c"].map((id) => ({ id, title: id, when: "" }));

test("weekly cadence starts on the first posting day on or after the start date", () => {
  // 2026-11-04 is a Wednesday; posting days Mon + Thu.
  const out = applyBulkScheduleDates({
    mode: "weekly",
    rows,
    startWhen: "2026-11-04T00:00",
    minWhen: "2026-11-04T00:00",
    timeZone: "Asia/Kolkata",
    articlesPerWeek: 2,
    weekdays: [1, 4],
    preferredTime: "09:00",
  }).map((r) => r.when);
  assert.equal([...out].sort()[0], "2026-11-05T09:00");
  assert.ok(out.every((w) => w >= "2026-11-04T00:00"));
});

test("monthly cadence starts on or after the start date", () => {
  const out = applyBulkScheduleDates({
    mode: "monthly",
    rows,
    startWhen: "2026-11-20T00:00",
    minWhen: "2026-11-20T00:00",
    timeZone: "Asia/Kolkata",
    postsPerMonth: 1,
    weekdays: [1],
    preferredTime: "09:00",
  }).map((r) => r.when);
  assert.deepEqual(out, ["2026-11-23T09:00", "2026-12-07T09:00", "2027-01-04T09:00"]);
});
