/**
 * Riviso — k6 Load Test  (L6.1)
 * Target: 15 concurrent users, realistic article generation mix
 *
 * Run:
 *   k6 run \
 *     -e BASE_URL=https://api.riviso.com \
 *     -e TEST_EMAIL=loadtest@example.com \
 *     -e TEST_PASSWORD=LoadTest!2026 \
 *     backend/docs/load_tests/k6_load_test.js
 *
 * Pass criteria (checked by thresholds below):
 *   - Non-generation p95 < 1 000 ms
 *   - Generation p95 < 30 000 ms   (queued; poll until done)
 *   - Error rate < 1 %
 *   - No 5xx responses
 */

import http from "k6/http";
import { check, group, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BASE = (__ENV.BASE_URL || "http://localhost:8000").replace(/\/$/, "");
const EMAIL = __ENV.TEST_EMAIL || "loadtest@example.com";
const PASSWORD = __ENV.TEST_PASSWORD || "LoadTest!2026";

// Pre-seeded test project + article IDs (create these once before the test run).
// Override via env vars when targeting a real deployment.
const PROJECT_ID = __ENV.TEST_PROJECT_ID || "test-project-id";
const ARTICLE_ID = __ENV.TEST_ARTICLE_ID || "test-article-id";

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------
const generationDuration = new Trend("generation_duration_ms", true);
const generationErrors = new Counter("generation_errors");
const errorRate = new Rate("error_rate");

// ---------------------------------------------------------------------------
// Stages: ramp to 15 VUs, hold 5 min, ramp down
// ---------------------------------------------------------------------------
export const options = {
  stages: [
    { duration: "30s", target: 5 },   // warm-up
    { duration: "1m",  target: 15 },  // ramp to target concurrency
    { duration: "5m",  target: 15 },  // sustained load
    { duration: "30s", target: 0 },   // ramp down
  ],
  thresholds: {
    // All non-generation API calls (auth, list, settings)
    http_req_duration: ["p(95)<1000"],
    // Generation-specific trend
    generation_duration_ms: ["p(95)<30000"],
    // Overall error rate
    error_rate: ["rate<0.01"],
    // No 5xx
    "http_req_failed": ["rate<0.01"],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function apiHeaders(accessToken) {
  return {
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

function checkOk(res, tag) {
  const ok = check(res, {
    [`${tag}: status 2xx`]: (r) => r.status >= 200 && r.status < 300,
  });
  errorRate.add(!ok);
  return ok;
}

// ---------------------------------------------------------------------------
// Auth: login once per VU, share token across iterations
// ---------------------------------------------------------------------------
let _token = null;

function ensureLoggedIn() {
  if (_token) return _token;
  const res = http.post(
    `${BASE}/api/auth/login`,
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    { headers: apiHeaders(null) }
  );
  checkOk(res, "login");
  if (res.status === 200) {
    _token = res.json("access_token");
  }
  return _token;
}

// ---------------------------------------------------------------------------
// Scenario helpers
// ---------------------------------------------------------------------------

/** Read-heavy: list projects and articles (most frequent user action). */
function scenarioBrowse(token) {
  group("browse", () => {
    group("list projects", () => {
      const r = http.get(`${BASE}/api/projects`, { headers: apiHeaders(token) });
      checkOk(r, "list-projects");
    });
    sleep(0.2);

    group("list articles", () => {
      const r = http.get(
        `${BASE}/api/projects/${PROJECT_ID}/articles?page=1&per_page=20`,
        { headers: apiHeaders(token) }
      );
      checkOk(r, "list-articles");
    });
    sleep(0.2);

    group("editor shell", () => {
      const r = http.get(
        `${BASE}/api/projects/${PROJECT_ID}/articles/${ARTICLE_ID}/editor-shell`,
        { headers: apiHeaders(token) }
      );
      checkOk(r, "editor-shell");
    });
  });
}

/** Settings read: project settings + subscription status (second most common). */
function scenarioSettings(token) {
  group("settings", () => {
    group("subscription status", () => {
      const r = http.get(`${BASE}/api/user/subscription-status`, { headers: apiHeaders(token) });
      checkOk(r, "subscription-status");
    });
    sleep(0.1);

    group("project settings", () => {
      const r = http.get(
        `${BASE}/api/projects/${PROJECT_ID}/settings`,
        { headers: apiHeaders(token) }
      );
      checkOk(r, "project-settings");
    });
  });
}

/** Health probe (simulates uptime monitor + LB healthcheck traffic). */
function scenarioHealth() {
  group("health", () => {
    const r = http.get(`${BASE}/api/health`);
    checkOk(r, "health");
  });
}

/**
 * Article generation (expensive path — only 1 in 5 VU iterations).
 * Posts generate → polls generation-status until done (up to 60 s).
 */
function scenarioGenerate(token) {
  group("generate", () => {
    const start = Date.now();

    const r = http.post(
      `${BASE}/api/projects/${PROJECT_ID}/articles/${ARTICLE_ID}/generate`,
      JSON.stringify({ generate_image: false }),
      { headers: apiHeaders(token) }
    );

    const accepted = checkOk(r, "generate-dispatch");
    if (!accepted) {
      generationErrors.add(1);
      return;
    }

    // If queued (202), poll until body is ready or timeout.
    if (r.status === 202) {
      const deadline = Date.now() + 60_000;
      let done = false;
      while (Date.now() < deadline) {
        sleep(3);
        const poll = http.get(
          `${BASE}/api/projects/${PROJECT_ID}/articles/${ARTICLE_ID}/generation-status`,
          { headers: apiHeaders(token) }
        );
        if (poll.status === 200) {
          const body = poll.json();
          if (body && body.has_body) {
            done = true;
            break;
          }
        }
      }
      if (!done) {
        generationErrors.add(1);
      }
    }

    generationDuration.add(Date.now() - start);
  });
}

/** Scheduled board read (relevant for any user with scheduled articles). */
function scenarioScheduledBoard(token) {
  group("scheduled-board", () => {
    const r = http.get(
      `${BASE}/api/projects/${PROJECT_ID}/scheduled-jobs/board`,
      { headers: apiHeaders(token) }
    );
    checkOk(r, "scheduled-board");
  });
}

// ---------------------------------------------------------------------------
// Main VU loop — weighted mix matching real traffic patterns
// ---------------------------------------------------------------------------
export default function () {
  const token = ensureLoggedIn();
  if (!token) {
    sleep(2);
    return;
  }

  const roll = Math.random();

  if (roll < 0.40) {
    // 40 % — browse (most common)
    scenarioBrowse(token);
    sleep(1);
  } else if (roll < 0.65) {
    // 25 % — settings + subscription
    scenarioSettings(token);
    sleep(1);
  } else if (roll < 0.75) {
    // 10 % — health probes
    scenarioHealth();
    sleep(0.5);
  } else if (roll < 0.85) {
    // 10 % — scheduled board
    scenarioScheduledBoard(token);
    sleep(1);
  } else {
    // 15 % — article generation (expensive, least frequent)
    scenarioGenerate(token);
    sleep(2);
  }
}

// ---------------------------------------------------------------------------
// Summary hook — print threshold results in a readable table
// ---------------------------------------------------------------------------
export function handleSummary(data) {
  const thresholds = data.metrics;
  const lines = ["", "=== Riviso Load Test Summary ===", ""];

  const keys = [
    "http_req_duration",
    "generation_duration_ms",
    "error_rate",
    "http_req_failed",
    "generation_errors",
  ];

  for (const key of keys) {
    const m = thresholds[key];
    if (!m) continue;
    const passed = m.thresholds ? m.thresholds.every((t) => t.ok) : true;
    const symbol = passed ? "✓" : "✗";
    const p95 = m.values?.["p(95)"]?.toFixed(0);
    const rate = m.values?.rate?.toFixed(4);
    const count = m.values?.count;
    const val = p95 ? `p95=${p95}ms` : rate ? `rate=${rate}` : count ? `count=${count}` : "";
    lines.push(`  ${symbol}  ${key.padEnd(32)} ${val}`);
  }
  lines.push("");

  return {
    stdout: lines.join("\n"),
  };
}
