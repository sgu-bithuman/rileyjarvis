// Headless end-to-end test for the browser agent (run on echelon over SSH).
// Usage: node test-browser.cjs "your goal here"
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createBrowserAgent } = require("./electron/browser.cjs");

const key = (fs.readFileSync(path.join(__dirname, ".env.local"), "utf8").match(/OPENAI_API_KEY=(.*)/) || [])[1].trim();
const CANDS = [process.env.RICKY_VISION_MODEL, "gpt-4.1", "gpt-4o", "gpt-5", "gpt-4o-mini"].filter(Boolean);
let winner = null;

async function callVision(messages, { json = false } = {}) {
  const cands = winner ? [winner, ...CANDS.filter((m) => m !== winner)] : CANDS;
  let lastErr = "none";
  for (const model of cands) {
    const body = { model, messages };
    if (json) body.response_format = { type: "json_object" };
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      winner = model;
      return (await r.json()).choices?.[0]?.message?.content || "";
    }
    lastErr = `${model}: ${r.status} ${(await r.text()).slice(0, 100)}`;
    if (!/model|not.?found|does not exist|unsupported/i.test(lastErr)) break;
  }
  throw new Error("vision failed: " + lastErr);
}

const DESTRUCTIVE = /\b(send|delete|remove|buy|purchase|pay|checkout|confirm|submit|discard|trash|unsubscribe)\b/i;
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

(async () => {
  const goal = process.argv[2] || "Go to example.com and tell me the exact page heading text.";
  const agent = createBrowserAgent({
    profileDir: path.join(os.tmpdir(), "rj-test-browser-profile"),
    headless: true,
    callVision,
    pushTranscript: (role, text) => console.log(`  [${role}] ${text}`),
    pushArtifact: () => {},
    isDestructive: (s) => DESTRUCTIVE.test(String(s || "")),
    confirmMatches: (a, b) => norm(a) && norm(b) && (norm(a).includes(norm(b)) || norm(b).includes(norm(a))),
  });
  console.log("GOAL:", goal);
  const t0 = Date.now();
  const result = await agent.runBrowserTask(goal, { maxSteps: Number(process.env.MAXSTEPS || 12) });
  console.log(`\nRESULT (${Math.round((Date.now() - t0) / 1000)}s, model=${winner}):`);
  console.log(JSON.stringify({ ok: result.ok, steps: result.steps, url: result.url, summary: result.summary, error: result.error }, null, 2));
  await agent.close();
  process.exit(result.ok ? 0 : 1);
})().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(2);
});
