import { chromium } from "playwright";
import { readFileSync } from "fs";

const token = readFileSync("/tmp/debug_token.txt", "utf8").trim();
const OUT = "/private/tmp/claude-501/-Users-akhileshsoni-Downloads-Riviso-SEO-main/85782c74-b30a-4da4-a547-d9776c17cc58/scratchpad";
const PROJECT_ID = "f5fb9512-7370-4f6f-9610-25feffa39ad8";

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addCookies([
  { name: "aa_access", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, secure: false, sameSite: "Lax" },
  { name: "aa_access", value: token, domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax" },
]);
await context.addInitScript(() => window.localStorage.setItem("aa_session", "1"));

const logs = [];
const page = await context.newPage();
page.on("console", (msg) => { if (msg.type() === "error") logs.push(msg.text()); });
page.on("pageerror", (err) => logs.push("pageerror: " + err.message));
page.on("response", (res) => { if (res.status() >= 400 && !res.url().includes("gstatic.com")) logs.push(`${res.status()} ${res.url()}`); });

await page.goto(`http://localhost:3000/projects/${PROJECT_ID}?tab=site_audit`, { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(500);
const seoLink = page.locator("text=SEO Audit").first();
if (await seoLink.count()) {
  await seoLink.click();
  await page.waitForTimeout(1200);
}
await page.screenshot({ path: `${OUT}/debug_overview.png`, fullPage: true });

const historyTab = page.locator("text=Crawl History").first();
if (await historyTab.count()) {
  await historyTab.click();
  await page.waitForTimeout(1000);
}
await page.screenshot({ path: `${OUT}/debug_history.png`, fullPage: true });

console.log(logs.length ? logs.join("\n") : "NO ERRORS");
