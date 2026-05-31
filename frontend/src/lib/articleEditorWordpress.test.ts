import { describe, expect, it } from "vitest";

import {
  canPushWordPressUpdate,
  isArticleLiveOnWordPress,
  parseWpPostId,
  shouldShowWordPressPublish,
  shouldShowWordPressUpdate,
} from "./articleEditorWordpress";

describe("articleEditorWordpress", () => {
  it("parseWpPostId accepts numbers and numeric strings", () => {
    expect(parseWpPostId(42)).toBe(42);
    expect(parseWpPostId("99")).toBe(99);
    expect(parseWpPostId("")).toBeNull();
    expect(parseWpPostId(0)).toBeNull();
  });

  it("live when wp id or link exists, even if listing status is draft", () => {
    expect(
      isArticleLiveOnWordPress({ articleStatus: "published", wpPostId: 1, wpLink: "" }),
    ).toBe(true);
    expect(
      isArticleLiveOnWordPress({
        articleStatus: "published",
        wpPostId: null,
        wpLink: "https://example.com/?p=5",
      }),
    ).toBe(true);
    expect(
      isArticleLiveOnWordPress({ articleStatus: "draft", wpPostId: 12, wpLink: "" }),
    ).toBe(true);
    expect(
      isArticleLiveOnWordPress({ articleStatus: "draft", wpPostId: null, wpLink: "" }),
    ).toBe(false);
    expect(
      isArticleLiveOnWordPress({ articleStatus: "pending", wpPostId: 1, wpLink: "" }),
    ).toBe(true);
  });

  it("update vs publish visibility", () => {
    const live = { articleStatus: "published", wpPostId: 10, wpLink: "" };
    const draft = { articleStatus: "draft", wpPostId: null, wpLink: "" };
    const linkedDraft = { articleStatus: "draft", wpPostId: 10, wpLink: "" };
    expect(shouldShowWordPressUpdate(live)).toBe(true);
    expect(shouldShowWordPressPublish(live)).toBe(false);
    expect(shouldShowWordPressUpdate(draft)).toBe(false);
    expect(shouldShowWordPressPublish(draft)).toBe(true);
    expect(shouldShowWordPressUpdate(linkedDraft)).toBe(true);
    expect(shouldShowWordPressPublish(linkedDraft)).toBe(false);
    expect(shouldShowWordPressPublish({ articleStatus: "scheduled", wpPostId: null, wpLink: "" })).toBe(
      false,
    );
  });

  it("canPushWordPressUpdate allows push when live on WordPress (with or without local edits)", () => {
    const ctx = { articleStatus: "published", wpPostId: 3, wpLink: "" };
    expect(
      canPushWordPressUpdate({
        ctx,
        websiteConnected: true,
        hasTitle: true,
        hasBody: true,
        hasPendingChanges: false,
        busy: false,
      }),
    ).toBe(true);
    expect(
      canPushWordPressUpdate({
        ctx,
        websiteConnected: true,
        hasTitle: true,
        hasBody: true,
        hasPendingChanges: true,
        busy: false,
      }),
    ).toBe(true);
    expect(
      canPushWordPressUpdate({
        ctx,
        websiteConnected: true,
        hasTitle: true,
        hasBody: true,
        busy: true,
      }),
    ).toBe(false);
  });
});
