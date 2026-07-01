// DOM-driven browser agent — the precise path for web tasks.
//
// Instead of screenshotting the desktop and guessing pixel coordinates (which is
// what made clicks miss), this drives a real Chromium via Playwright and acts on
// exact element references from the page structure. No coordinate guessing, and
// Playwright's own screenshots/DOM need no macOS Screen Recording / Accessibility.
//
// Runs in a dedicated, isolated user-data profile (a sandbox separate from the
// user's main Chrome), so a task can't touch their logged-in browser state unless
// they log in inside this profile on purpose.

// Tag visible, interactive elements with stable refs the model can target.
// Passed to page.evaluate as a real function (runs in the page; browser globals only).
function snapshotFn() {
  document.querySelectorAll("[data-ai-ref]").forEach((e) => e.removeAttribute("data-ai-ref"));
  const sel =
    'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=menuitem],[role=menuitemcheckbox],[role=combobox],[role=switch],[role=option],[contenteditable=""],[contenteditable=true],[onclick],summary';
  const out = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) continue;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) continue;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    if (el.disabled) continue;
    const ref = "e" + ++n;
    el.setAttribute("data-ai-ref", ref);
    const name = (
      el.getAttribute("aria-label") ||
      (el.innerText || "").trim() ||
      el.value ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      el.getAttribute("name") ||
      el.getAttribute("alt") ||
      ""
    )
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 90);
    const role = el.getAttribute("role") || el.tagName.toLowerCase();
    out.push({ ref, role, name });
    if (n >= 200) break;
  }
  return { url: location.href, title: document.title, elements: out };
}

const SYSTEM = `You are Ricky's web browsing planner. You drive a real Chromium browser to accomplish a goal.
Each step you get the current URL, page title, a screenshot, and a list of interactive elements, each with a ref id, role, and name.
Respond with STRICT JSON only, no prose:
{"thought":"<one short line>","done":<bool>,"say":"<summary, only when done>","action":<action object or null>}
Actions (act on elements by REF, never by coordinates):
- {"type":"navigate","url":"https://..."}
- {"type":"click","ref":"e5"}
- {"type":"type","ref":"e7","text":"...","submit":true}   submit=true presses Enter after typing
- {"type":"scroll","direction":"up|down","amount":8}
- {"type":"key","key":"Enter"}
- {"type":"wait","ms":1000}
Rules: click/type by ref from the list; take ONE action per step; after acting, re-read the next snapshot before continuing.
If the element you need isn't listed, scroll to reveal more. Set done=true with a short 'say' the moment the goal is satisfied. Never claim success you cannot see.`;

function createBrowserAgent(deps) {
  const {
    profileDir,
    headless = false,
    channel, // e.g. "chrome" to use installed Chrome; undefined = bundled Chromium
    callVision,
    pushArtifact = () => {},
    pushTranscript = () => {},
    isDestructive = () => false,
    confirmMatches = () => false,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = deps;

  let context = null;
  let page = null;
  let lastNames = new Map(); // ref -> accessible name, for the safety check

  async function ensure() {
    if (context && page && !page.isClosed()) return page;
    let chromium;
    try {
      ({ chromium } = require("playwright"));
    } catch {
      throw new Error("Playwright isn't installed. Run: npm install playwright && npx playwright install chromium");
    }
    context = await chromium.launchPersistentContext(profileDir, {
      headless,
      channel,
      viewport: null,
      args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
    });
    page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(9000);
    return page;
  }

  async function snapshot() {
    const p = await ensure();
    const snap = await p.evaluate(snapshotFn);
    lastNames = new Map(snap.elements.map((e) => [e.ref, e.name]));
    return snap;
  }

  function elementList(snap) {
    if (!snap.elements.length) return "(no interactive elements in view — try scrolling or navigating)";
    return snap.elements.map((e) => `${e.ref} ${e.role}${e.name ? ` "${e.name}"` : ""}`).join("\n");
  }

  async function execAction(action) {
    const p = await ensure();
    const type = String(action.type || "");
    if (type === "navigate") {
      let url = String(action.url || "");
      if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
      await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      return `navigated to ${url}`;
    }
    if (type === "click") {
      const ref = String(action.ref || "");
      await p.click(`[data-ai-ref="${ref}"]`, { timeout: 9000 });
      const name = lastNames.get(ref);
      return `clicked ${ref}${name ? ` "${name}"` : ""}`;
    }
    if (type === "type") {
      const ref = String(action.ref || "");
      const loc = p.locator(`[data-ai-ref="${ref}"]`);
      await loc.fill(String(action.text || ""), { timeout: 9000 });
      if (action.submit) await p.keyboard.press("Enter");
      return `typed into ${ref}${action.submit ? " + Enter" : ""}`;
    }
    if (type === "key") {
      await p.keyboard.press(String(action.key || "Enter"));
      return `pressed ${action.key || "Enter"}`;
    }
    if (type === "scroll") {
      const amount = Math.max(1, Math.min(50, Number(action.amount || 8))) * 100;
      await p.mouse.wheel(0, action.direction === "up" ? -amount : amount);
      return `scrolled ${action.direction || "down"}`;
    }
    if (type === "wait") {
      await sleep(Math.min(4000, Number(action.ms || 1000)));
      return "waited";
    }
    throw new Error(`unknown browser action: ${type}`);
  }

  async function runBrowserTask(goal, { maxSteps = 14, confirmTarget = "" } = {}) {
    if (!goal.trim()) return { ok: false, error: "No goal was given for the task." };
    await ensure();
    const history = [];
    pushTranscript("tool", `Browsing: ${goal}`);

    for (let step = 1; step <= maxSteps; step += 1) {
      const snap = await snapshot();
      const p = await ensure();
      let shot = "";
      try {
        shot = "data:image/png;base64," + (await p.screenshot({ type: "png" })).toString("base64");
        pushArtifact({ title: `Browse · step ${step}`, kind: "image", content: shot });
      } catch {
        /* screenshot is best-effort context for the planner */
      }

      const content = [
        {
          type: "text",
          text:
            `Goal: ${goal}\n` +
            `Step ${step} of ${maxSteps}\n` +
            `URL: ${snap.url}\n` +
            `Title: ${snap.title}\n\n` +
            `Interactive elements (act by ref):\n${elementList(snap)}\n\n` +
            `Recent actions:\n${history.slice(-6).map((h) => `- ${h}`).join("\n") || "(none yet)"}\n\n` +
            `Decide the single next action. Respond with JSON only.`,
        },
      ];
      if (shot) content.push({ type: "image_url", image_url: { url: shot } });

      let plan;
      try {
        plan = JSON.parse(await callVision([{ role: "system", content: SYSTEM }, { role: "user", content }], { json: true }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pushTranscript("tool", `Planner error: ${message}`);
        return { ok: false, error: `Planner error: ${message}` };
      }

      if (plan.thought) pushTranscript("tool", `Step ${step}: ${plan.thought}`);

      if (plan.done === true) {
        const summary = plan.say || "Done.";
        pushTranscript("tool", `Done: ${summary}`);
        return {
          ok: true,
          steps: step,
          url: snap.url,
          summary,
          artifact: {
            title: "Browsing",
            kind: "markdown",
            content: `# ${goal}\n\n${history.map((h) => `- ${h}`).join("\n") || "- (no steps)"}\n\n**Result:** ${summary}`,
          },
        };
      }

      if (!plan.action || typeof plan.action !== "object") {
        history.push("(no action returned)");
        continue;
      }

      // Same host-enforced safety as the desktop path: a destructive-looking ref
      // (send/delete/buy/pay/…) pauses for confirmation unless this exact control
      // was already approved via confirmTarget.
      if (plan.action.type === "click") {
        const name = lastNames.get(String(plan.action.ref || "")) || "";
        if (isDestructive(name) && !confirmMatches(name, confirmTarget)) {
          pushTranscript("tool", `Paused — needs confirmation to click "${name}".`);
          return {
            ok: false,
            requiresConfirmation: true,
            pendingTarget: name,
            message: `To continue "${goal}", Ricky needs to click "${name}", which looks destructive (send/delete/pay/buy). Ask the user to confirm out loud; if they approve, call browser_task again with the same goal and confirmTarget set to exactly "${name}".`,
          };
        }
      }

      try {
        const result = await execAction(plan.action);
        history.push(result);
        pushTranscript("tool", result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        history.push(`error: ${message}`);
        pushTranscript("tool", `Action error: ${message}`);
      }
      await sleep(450);
    }

    return {
      ok: true,
      steps: maxSteps,
      summary: `Stopped at the ${maxSteps}-step limit before finishing.`,
      artifact: {
        title: "Browsing",
        kind: "markdown",
        content: `# ${goal}\n\n${history.map((h) => `- ${h}`).join("\n")}\n\nStopped at the step limit.`,
      },
    };
  }

  async function openUrl(url) {
    const p = await ensure();
    let target = String(url || "");
    if (target && !/^https?:\/\//i.test(target)) target = "https://" + target;
    await p.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 });
    return { ok: true, url: p.url(), title: await p.title() };
  }

  async function readPage() {
    const p = await ensure();
    const text = await p.evaluate(() => document.body.innerText.replace(/\n{3,}/g, "\n\n").slice(0, 8000));
    return { ok: true, url: p.url(), title: await p.title(), text };
  }

  async function close() {
    if (context) {
      await context.close().catch(() => {});
      context = null;
      page = null;
    }
    return { ok: true };
  }

  return { ensure, snapshot, runBrowserTask, openUrl, readPage, close };
}

module.exports = { createBrowserAgent };
