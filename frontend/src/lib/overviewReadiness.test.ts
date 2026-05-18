import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ArticlePublic, WorkspaceOverviewResponse } from "@/lib/api";

import {
  countActiveDaysInSeries,
  evaluateProjectOverviewReadiness,
  evaluateWorkspaceOverviewReadiness,
  OVERVIEW_MIN_ACTIVE_DAYS,
  OVERVIEW_MIN_ARTICLES,
} from "./overviewReadiness";

function article(partial: Partial<ArticlePublic> & { id: string }): ArticlePublic {
  return {
    id: partial.id,
    project_id: partial.project_id || "p1",
    title: partial.title || "Article",
    status: partial.status || "draft",
    created_at: partial.created_at || "2026-05-01T10:00:00.000Z",
    updated_at: partial.updated_at || partial.created_at || "2026-05-01T10:00:00.000Z",
    posted_at: partial.posted_at ?? null,
    wp_scheduled_at: partial.wp_scheduled_at ?? null,
    image_url: partial.image_url ?? null,
    ...partial,
  } as ArticlePublic;
}

describe("overviewReadiness", () => {
  it("counts active days in a series", () => {
    const n = countActiveDaysInSeries([
      { date: "2026-05-01", published: 0, pending: 0, scheduled: 0 },
      { date: "2026-05-02", published: 2, pending: 0, scheduled: 0 },
      { date: "2026-05-03", published: 0, pending: 1, scheduled: 0 },
    ]);
    assert.equal(n, 2);
  });

  it("locks project overview for empty pipeline", () => {
    const readiness = evaluateProjectOverviewReadiness(
      [
        article({ id: "a1", status: "draft" }),
        article({ id: "a2", status: "draft" }),
      ],
      [],
    );
    assert.equal(readiness.isReady, false);
    assert.equal(readiness.checklist.find((c) => c.id === "pipeline")?.done, false);
  });

  it("unlocks project overview with articles and activity spread", () => {
    const articles = [
      article({
        id: "a1",
        status: "published",
        posted_at: "2026-05-10T10:00:00.000Z",
        created_at: "2026-05-01T10:00:00.000Z",
      }),
      article({
        id: "a2",
        status: "published",
        posted_at: "2026-05-12T10:00:00.000Z",
        created_at: "2026-05-02T10:00:00.000Z",
      }),
      article({
        id: "a3",
        status: "pending",
        updated_at: "2026-05-14T10:00:00.000Z",
        created_at: "2026-05-03T10:00:00.000Z",
      }),
    ];
    const readiness = evaluateProjectOverviewReadiness(articles, [], 28);
    assert.equal(readiness.isReady, true);
  });

  it("locks workspace overview until article threshold", () => {
    const data: WorkspaceOverviewResponse = {
      stats: {
        project_count: 1,
        published: 0,
        pending: 2,
        draft: 1,
        upcoming_scheduled: 0,
        total_articles: 3,
      },
      activity_series: Array.from({ length: 14 }, (_, i) => ({
        date: `2026-05-${String(i + 1).padStart(2, "0")}`,
        published: i === 0 ? 1 : 0,
        pending: 0,
        scheduled: 0,
      })),
      upcoming_scheduled: [],
      recently_published: [],
      pending: [],
      drafts: [],
    };
    const readiness = evaluateWorkspaceOverviewReadiness(data);
    assert.equal(readiness.isReady, false);
    assert.equal(readiness.checklist.find((c) => c.id === "articles")?.done, false);
  });

  it("unlocks workspace overview with enough articles and active days", () => {
    const data: WorkspaceOverviewResponse = {
      stats: {
        project_count: 2,
        published: 12,
        pending: 4,
        draft: 2,
        upcoming_scheduled: 3,
        total_articles: OVERVIEW_MIN_ARTICLES + 10,
      },
      activity_series: Array.from({ length: 14 }, (_, i) => ({
        date: `2026-05-${String(i + 1).padStart(2, "0")}`,
        published: i % 2 === 0 ? 2 : 0,
        pending: i % 3 === 0 ? 1 : 0,
        scheduled: 0,
      })),
      upcoming_scheduled: [],
      recently_published: [],
      pending: [],
      drafts: [],
    };
    const readiness = evaluateWorkspaceOverviewReadiness(data);
    assert.equal(readiness.isReady, true);
    assert.ok(readiness.activeDays >= OVERVIEW_MIN_ACTIVE_DAYS);
  });
});
