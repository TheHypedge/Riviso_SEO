import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiError } from "@/lib/api";

import { articleEditorPath, formatArticleLoadError, isValidArticleRef } from "./articlePaths";

describe("articlePaths", () => {
  it("builds encoded editor paths", () => {
    const path = articleEditorPath("proj-1", "art-2");
    assert.equal(path, "/projects/proj-1/articles/art-2");
  });

  it("rejects empty ids", () => {
    assert.equal(articleEditorPath("", "x"), null);
    assert.equal(isValidArticleRef("proj", ""), false);
  });

  it("maps 404 ApiError to not-found copy", () => {
    const info = formatArticleLoadError(new ApiError("Not found", 404));
    assert.equal(info.notFound, true);
    assert.equal(info.canRetry, false);
  });

  it("maps network errors to retryable copy", () => {
    const info = formatArticleLoadError(new TypeError("Failed to fetch"));
    assert.equal(info.canRetry, true);
    assert.match(info.message, /connection/i);
  });
});
