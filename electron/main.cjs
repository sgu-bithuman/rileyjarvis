const { app, BrowserWindow, ipcMain, nativeImage, screen } = require("electron");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const dotenv = require("dotenv");
const { createBrowserAgent } = require("./browser.cjs");

dotenv.config({ path: path.join(process.cwd(), ".env.local") });

const execFileAsync = promisify(execFile);
const dataDir = path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "ricky-db.json");
let currentMode = "display";
let mainWindow = null;
let normalWindowBounds = null;
let dbWriteQueue = Promise.resolve();

const RICKY_INSTRUCTIONS = `# Role and Objective
You are Ricky, Riley's desktop AI operator. You speak through realtime voice and can use local tools.

# Personality and Tone
Concise, calm, useful. Use a confident man's voice. Talk like a smart operator, not a chatbot.

# Modes
- Display mode is the default. Use the app and artifact panel to show things. Do not control the computer.
- Computer use mode allows desktop control tools. Only use computer tools after the user asks for computer use or asks you to do something on their screen.

# Doing things for the user
- For anything on the WEB — searching, looking something up, browsing, filling forms, shopping, booking, reading a page — use browser_task. It drives a real browser by the page's actual structure, so it is precise and does not misclick. This is the preferred way to get most things done; the user has a dedicated browser for this.
- Use browser_open + browser_read for a quick "what does this page say" without a full task.
- Only use computer_task for NATIVE macOS apps (Finder, Notes, Mail, System Settings, Music) — things that aren't in a browser. It observes the screen and acts step by step; accessibility support varies by app, so prefer the web path whenever the task can be done online.
- For a quick one-off, use the primitives directly: computer_see (look at the screen), computer_inspect (list clickable elements), then computer_click (by index or label — never guess raw pixels if an element exists), computer_type, computer_key, computer_scroll.
- To answer "what's on my screen" or "what does this say", use computer_see.
- clipboard_read / clipboard_write are handy for moving text between apps without retyping.
- If computer_task returns requiresConfirmation, tell the user exactly what it named (the pendingTarget), ask them out loud, and only if they approve call computer_task again with the same goal and confirmTarget set to that exact string. This approves only that one control.

# Tool Behavior
- Use read-only tools when the user's intent is clear.
- When Riley says "show me the menu", "show me what I can do", or asks what Ricky can do, call show_menu immediately.
- For web search, notes, charts, records, image generation, and artifact display, act directly when the request is clear.
- For thumbnail creation/editing, always use the thumbnail board tools, never generic image_generate and never artifact_show with imageLoading. Generate exactly one 16:9 image per request. Never generate multiple unless Riley separately asks again. Every generate/edit request gets a permanent database number that never changes, like #18 then #19 then #20. Do not renumber visible grid positions. Show paginated 3x3 pages of the permanent numbers. Do not show a standalone fullscreen loading animation for thumbnails. Use Riley's wording literally: do not invent elaborate extra concepts, fake text, or extra thumbnail ideas. For edits, use the exact existing numbered/selected image as input and make only the requested change.
- The thumbnail board persists across sessions. If Riley references thumbnail #N, trust that permanent number and call the matching thumbnail tool. Do not say you cannot see old thumbnails. Use thumbnail_grid to refresh state or change pages if needed.
- When a thumbnail finishes generating or editing, do not announce it verbally. The UI updates silently.
- For sending messages, deleting data, buying things, account changes, sharing private information, or anything irreversible, summarize the action and ask for explicit confirmation before calling the modifying tool.
- If a tool requires a confirmed field, set confirmed to true only after the user clearly confirms.
- Typing text and pressing Enter/Return in computer use mode are allowed without extra approval when Riley asks you to type or send a prompt. Ask first before clicking controls or taking actions that delete, purchase, change settings, or expose private information.
- Explain what you are doing in one short sentence before longer tool work. Do not over-explain.

# Artifacts
Use artifacts for menus, web results, graphics, notes, database tables, code snippets, and task progress. If the user asks to show, hide, or fullscreen the artifacts panel, call the artifact tool.
For Mermaid charts, keep syntax simple: start with flowchart TD, avoid markdown fences, avoid parentheses in node labels, and use short alphanumeric node IDs.

# Audio
Let the user interrupt. If audio is unclear, ask one short clarifying question instead of guessing.`;

const toolSpecs = [
  {
    type: "function",
    name: "set_mode",
    description: "Switch Ricky between display mode and computer use mode.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["display", "computer"] },
      },
      required: ["mode"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "artifact_show",
    description: "Show structured content in the artifact panel. Use for notes, menus, web results, charts, code, task progress, and visual content.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        kind: { type: "string", enum: ["text", "markdown", "code", "table", "notes", "mermaid", "image", "imageLoading", "thumbnailBoard", "progress"] },
        content: { type: "string" },
        language: { type: "string" },
        fullscreen: { type: "boolean" },
      },
      required: ["title", "kind", "content"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "show_menu",
    description: "Show Ricky's capability menu in the artifact panel. Call this when the user asks 'show me the menu', 'show me what I can do', or asks what Ricky can do.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "web_search",
    description: "Search the web with Exa. Use for current facts, links, research, and source gathering. Results are shown as a clean Markdown research brief in the artifact panel.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        numResults: { type: "number", minimum: 1, maximum: 10 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "image_generate",
    description: "Generate a standalone image with GPT Image and show it in the artifact panel. Do not use for YouTube thumbnails, thumbnail edits, or the thumbnail board; use thumbnail_generate or thumbnail_edit instead.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        size: { type: "string", enum: ["1024x1024", "1024x1536", "1536x1024"] },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "thumbnail_reference_add",
    description: "Add a local image file as a reference image for making thumbnails of Riley. Use when Riley gives a file path to a photo of himself.",
    parameters: {
      type: "object",
      properties: {
        imagePath: { type: "string" },
        label: { type: "string" },
      },
      required: ["imagePath"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "thumbnail_generate",
    description: "Generate exactly one 16:9 YouTube thumbnail into Ricky's persistent paginated thumbnail board. Uses Riley reference images if available. Assigns a new permanent number that never changes. Never generate multiple at once.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "thumbnail_edit",
    description: "Edit one existing thumbnail by permanent thumbnail number, or edit the currently selected thumbnail if number is omitted. Use this whenever Riley says 'edit number 20' or 'edit this'. The edited result gets a new permanent number.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        number: { type: "number", minimum: 1 },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "thumbnail_select",
    description: "Select a permanent numbered thumbnail and show it fullscreen. Use when Riley says 'pull up number 20', 'show number 20', 'open number 20', or 'select number 20'.",
    parameters: {
      type: "object",
      properties: {
        number: { type: "number", minimum: 1 },
      },
      required: ["number"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "thumbnail_grid",
    description: "Show one paginated 3x3 page of the persistent thumbnail board and return compact board state. Use to refresh state, change pages, or when Riley asks what thumbnails exist.",
    parameters: {
      type: "object",
      properties: {
        page: { type: "number", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "mermaid_render",
    description: "Render a Mermaid chart in the artifact panel. Provide only Mermaid code, no markdown fences. Prefer flowchart TD with quoted labels.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        diagram: { type: "string" },
      },
      required: ["title", "diagram"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "note_add",
    description: "Add a note to Ricky's fun local notes list.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "records_create",
    description: "Create a local database record.",
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string" },
        title: { type: "string" },
        fields: { type: "object", additionalProperties: true },
      },
      required: ["collection", "title"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "records_search",
    description: "Search local database records by collection and query.",
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string" },
        query: { type: "string" },
      },
      required: ["collection"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "records_update",
    description: "Update a local database record. Ask for confirmation first if the change is sensitive or destructive.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        fields: { type: "object", additionalProperties: true },
        confirmed: { type: "boolean" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "records_delete",
    description: "Delete a local database record. Always ask the user for explicit confirmation first, then call with confirmed true.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        confirmed: { type: "boolean" },
      },
      required: ["id", "confirmed"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "browser_task",
    description:
      "Autonomously do a task on the WEB in a real browser (search, look something up, browse a site, fill a form, shop, book, read a page). This is the PRECISE path for anything online — it acts on the page's actual elements, not screen pixels, so it doesn't misclick. Prefer this over computer_task for anything web-related. If it returns requiresConfirmation, ask the user, then call again with the same goal and confirmTarget set to the pendingTarget string.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "The web task to accomplish, in plain language." },
        maxSteps: { type: "number", minimum: 1, maximum: 30 },
        confirmTarget: { type: "string", description: "Only after the user approves a destructive step: the exact pendingTarget string from the prior result." },
      },
      required: ["goal"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "browser_open",
    description: "Open a URL in Ricky's browser (and return its title). Use before browser_read, or when the user names a site.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "browser_read",
    description: "Return the readable text of the current browser page. Use to answer questions about what's on the page.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "computer_task",
    description:
      "Autonomously accomplish a multi-step task on the user's screen (e.g. 'open Safari and search for X', 'reply to the top email', 'find the cheapest flight'). Ricky observes the screen, plans, and acts step by step, verifying visually. Use this for anything beyond a single click or keystroke. Enters computer use mode automatically. If it returns requiresConfirmation, tell the user what it named and ask out loud; if they approve, call again with the same goal and confirmTarget set to exactly the pendingTarget string it returned.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "The task to accomplish, in plain language." },
        maxSteps: { type: "number", minimum: 1, maximum: 30 },
        confirmTarget: {
          type: "string",
          description: "Only after the user approves a specific destructive step: the exact pendingTarget string from the prior requiresConfirmation result. Approves just that one control, nothing else.",
        },
      },
      required: ["goal"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "computer_see",
    description: "Look at the user's screen and describe it, or answer a specific question about what's visible. This is Ricky's eyes. Requires computer mode.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "Optional specific question about what is on screen." },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "computer_inspect",
    description: "List the clickable/interactive elements of the frontmost app via Accessibility, each with an index, role, label, and coordinates. Call this before computer_click to click by index or label instead of guessing pixels. Requires computer mode.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "computer_open_app",
    description: "Open a macOS app by name. Requires computer mode.",
    parameters: {
      type: "object",
      properties: { appName: { type: "string" } },
      required: ["appName"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "computer_click",
    description:
      "Click a UI element. Prefer index (from computer_inspect) or a label; fall back to x/y or xNorm/yNorm (0-1 fraction of screen). Requires computer mode. Ricky auto-confirms destructive-looking targets, so ask the user before clicking send/delete/buy/submit.",
    parameters: {
      type: "object",
      properties: {
        index: { type: "number", description: "Element index from computer_inspect." },
        label: { type: "string", description: "Visible label/text of the element to click." },
        x: { type: "number" },
        y: { type: "number" },
        xNorm: { type: "number", minimum: 0, maximum: 1 },
        yNorm: { type: "number", minimum: 0, maximum: 1 },
        button: { type: "string", enum: ["left", "right"] },
        double: { type: "boolean" },
        confirmed: { type: "boolean" },
        risk: { type: "string", enum: ["low", "may_send_or_modify", "private_or_sensitive"] },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "computer_type",
    description: "Type text into the focused field. Requires computer mode. Set submit true to press Return after. paste true is more reliable for long or special text. No extra confirmation needed just to type.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        submit: { type: "boolean" },
        paste: { type: "boolean" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "computer_key",
    description: "Press a key or shortcut, including modifiers (e.g. 'return', 'escape', 'cmd+c', 'cmd+shift+t', 'arrowdown'). Requires computer mode.",
    parameters: {
      type: "object",
      properties: {
        combo: { type: "string", description: "e.g. 'cmd+t', 'return', 'escape', 'arrowdown'." },
        repeat: { type: "number", minimum: 1, maximum: 20 },
      },
      required: ["combo"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "computer_scroll",
    description: "Scroll the active app with the real scroll wheel. Requires computer mode.",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number", minimum: 1, maximum: 50 },
      },
      required: ["direction"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "computer_move",
    description: "Move the cursor to an element (index/label) or coordinates without clicking. Requires computer mode.",
    parameters: {
      type: "object",
      properties: {
        index: { type: "number" },
        label: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        xNorm: { type: "number", minimum: 0, maximum: 1 },
        yNorm: { type: "number", minimum: 0, maximum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "clipboard_read",
    description: "Read the current macOS clipboard contents.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "clipboard_write",
    description: "Put text on the macOS clipboard so the user (or a paste) can use it.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

async function ensureData() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(dbPath);
  } catch {
    await fs.writeFile(dbPath, JSON.stringify(defaultDb(), null, 2));
  }
}

async function readDb() {
  await ensureData();
  const raw = await fs.readFile(dbPath, "utf8");
  return normalizeDb(JSON.parse(raw));
}

async function writeDb(db) {
  await ensureData();
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2));
}

async function updateDb(mutator) {
  const operation = dbWriteQueue.then(async () => {
    const db = await readDb();
    const result = await mutator(db);
    await writeDb(db);
    return { db, result };
  });
  dbWriteQueue = operation.catch(() => {});
  return operation;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function defaultDb() {
  return {
    notes: [],
    records: [],
    thumbnailBoard: {
      references: [],
      images: [],
      nextNumber: 1,
      page: 1,
      pageSize: 9,
      selectedId: null,
      view: "grid",
    },
  };
}

function normalizeDb(db) {
  const next = db && typeof db === "object" ? db : defaultDb();
  if (!Array.isArray(next.notes)) next.notes = [];
  if (!Array.isArray(next.records)) next.records = [];
  if (!next.thumbnailBoard || typeof next.thumbnailBoard !== "object") {
    next.thumbnailBoard = defaultDb().thumbnailBoard;
  }
  if (!Array.isArray(next.thumbnailBoard.references)) next.thumbnailBoard.references = [];
  if (!Array.isArray(next.thumbnailBoard.images)) next.thumbnailBoard.images = [];
  let maxNumber = 0;
  for (const image of [...next.thumbnailBoard.images].reverse()) {
    if (!Number.isInteger(image.number) || image.number < 1) image.number = maxNumber + 1;
    maxNumber = Math.max(maxNumber, image.number);
  }
  if (!Number.isInteger(next.thumbnailBoard.nextNumber) || next.thumbnailBoard.nextNumber <= maxNumber) {
    next.thumbnailBoard.nextNumber = maxNumber + 1;
  }
  if (!Number.isInteger(next.thumbnailBoard.page) || next.thumbnailBoard.page < 1) next.thumbnailBoard.page = 1;
  if (!Number.isInteger(next.thumbnailBoard.pageSize) || next.thumbnailBoard.pageSize < 1) next.thumbnailBoard.pageSize = 9;
  if (typeof next.thumbnailBoard.view !== "string") next.thumbnailBoard.view = "grid";
  if (!("selectedId" in next.thumbnailBoard)) next.thumbnailBoard.selectedId = null;
  return next;
}

async function clearStartupLoadingThumbnails() {
  const db = await readDb();
  const before = db.thumbnailBoard.images.length;
  db.thumbnailBoard.images = db.thumbnailBoard.images.filter((image) => image.status !== "loading");
  if (db.thumbnailBoard.images.length !== before) {
    db.thumbnailBoard.selectedId = null;
    db.thumbnailBoard.view = "grid";
    await writeDb(db);
  }
}

function requireComputerMode() {
  if (currentMode !== "computer") {
    return {
      ok: false,
      needsMode: "computer",
      message: "Computer control is disabled. Ask Ricky to switch to computer use mode first.",
    };
  }
  return null;
}

function requiresConfirmation(args) {
  return args.confirmed !== true && (args.risk === "may_send_or_modify" || args.risk === "private_or_sensitive");
}

function keyCodeForKey(key) {
  const keyCodes = {
    enter: 36,
    return: 36,
    tab: 48,
    escape: 53,
    delete: 51,
    space: 49,
    up: 126,
    down: 125,
    left: 123,
    right: 124,
  };
  return keyCodes[String(key || "").toLowerCase()] || null;
}

function appleScriptString(value) {
  return JSON.stringify(String(value)).replace(/\\\\/g, "\\");
}

// ---------------------------------------------------------------------------
// Native macOS bridge (Accessibility geometry + CGEvent input) and vision.
// This is what makes computer use actually reliable instead of blind.
// ---------------------------------------------------------------------------

const repoRoot = path.join(__dirname, "..");
const nativeDir = path.join(repoRoot, "native");
const bridgeBin = path.join(nativeDir, "mac-bridge");
let bridgeBuildPromise = null;
let lastAxElements = []; // cache from the most recent inspect/loop step, for click-by-index/label
let taskCancelRequested = false; // set when the user switches back to display mid-task

async function ensureBridge() {
  try {
    await fs.access(bridgeBin);
    return true;
  } catch {
    if (!bridgeBuildPromise) {
      bridgeBuildPromise = execFileAsync("bash", [path.join(nativeDir, "build.sh")], { cwd: repoRoot }).catch(
        (error) => {
          bridgeBuildPromise = null;
          throw error;
        },
      );
    }
    await bridgeBuildPromise;
    return true;
  }
}

async function bridge(...args) {
  await ensureBridge();
  const { stdout } = await execFileAsync(bridgeBin, args.map(String), { maxBuffer: 16 * 1024 * 1024 });
  const parsed = JSON.parse(stdout.trim());
  if (parsed.ok === false) throw new Error(parsed.error || "bridge error");
  return parsed;
}

async function bridgePermissions() {
  try {
    return await bridge("permcheck");
  } catch {
    return { accessibility: false, screenRecording: false };
  }
}

async function displayInfo() {
  try {
    return await bridge("displayinfo");
  } catch {
    return { width: 1440, height: 900, scale: 2 };
  }
}

function sipsDimensions(stdout) {
  const w = /pixelWidth:\s*(\d+)/.exec(stdout);
  const h = /pixelHeight:\s*(\d+)/.exec(stdout);
  return { width: w ? Number(w[1]) : 0, height: h ? Number(h[1]) : 0 };
}

const VISION_MAX_WIDTH = 1280;

// Capture the screen, downscale for cheap vision. Click accuracy does NOT depend on
// this size — clicks use AX element geometry or normalized coords mapped to logical points.
async function captureScreen() {
  await fs.mkdir(dataDir, { recursive: true });
  const stamp = `${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
  const rawPath = path.join(dataDir, `shot-${stamp}.png`);
  await execFileAsync("screencapture", ["-x", "-t", "png", rawPath]);
  // screencapture can exit 0 while writing nothing when Screen Recording is denied.
  const rawStat = await fs.stat(rawPath).catch(() => null);
  if (!rawStat || rawStat.size === 0) {
    throw new Error(
      "Could not capture the screen. Enable Screen Recording for this app in System Settings → Privacy & Security → Screen Recording, then try again.",
    );
  }
  const { stdout } = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", rawPath]);
  const pixels = sipsDimensions(stdout);
  const smallPath = path.join(dataDir, `shot-${stamp}-v.png`);
  const targetW = Math.max(320, Math.min(VISION_MAX_WIDTH, pixels.width || VISION_MAX_WIDTH));
  await execFileAsync("sips", ["-Z", String(targetW), rawPath, "--out", smallPath]);
  const buffer = await fs.readFile(smallPath);
  return { path: smallPath, dataUrl: `data:image/png;base64,${buffer.toString("base64")}` };
}

// Chat-completions vision call with model auto-discovery (the account's exact vision
// model is unknown, so probe a candidate list once and cache the winner).
// Order matters: the agent loop makes one vision call per step, so latency compounds.
// gpt-4.1 is fast (~0.8s) and strong at UI grounding; gpt-5 is a slower heavy fallback.
const PLANNER_CANDIDATES = [process.env.RICKY_VISION_MODEL, "gpt-4.1", "gpt-4o", "gpt-5", "gpt-4o-mini"].filter(Boolean);
let plannerModel = null;

async function callVision(messages, { json = false } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing in .env.local.");
  // Prefer the cached winner, but still fall through to the others if it fails for
  // this particular call (e.g. a model that works for describe but rejects json mode).
  const candidates = plannerModel
    ? [plannerModel, ...PLANNER_CANDIDATES.filter((m) => m !== plannerModel)]
    : PLANNER_CANDIDATES;
  let lastError = "no vision model available";
  for (const model of candidates) {
    const body = { model, messages };
    if (json) body.response_format = { type: "json_object" };
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) {
      plannerModel = model;
      const data = await response.json();
      return data.choices?.[0]?.message?.content || "";
    }
    lastError = `${response.status} ${await response.text()}`;
    if (!/model|not\s*found|does not exist|unsupported|invalid/i.test(lastError)) break;
  }
  throw new Error(`Vision request failed: ${lastError}`);
}

// Push updates into the renderer while a long tool (computer_task) runs.
function pushArtifact(artifact) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("ricky:push-artifact", artifact);
}
function pushTranscript(role, text) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("ricky:push-transcript", { role, text });
}

const DESTRUCTIVE = /\b(send|delete|remove|buy|purchase|pay|checkout|confirm|submit|discard|trash|unsubscribe|deactivate|sign\s*out|log\s*out|reset|erase|wipe|format)\b/i;

function axSummary(elements) {
  if (!elements.length) return "(no accessible elements — the app may not expose Accessibility, use vision coordinates)";
  return elements
    .map((el) => `#${el.i} ${el.role.replace(/^AX/, "")}${el.label ? ` "${el.label}"` : ""} @(${el.cx},${el.cy})`)
    .join("\n");
}

function resolveTarget(args, logical) {
  if (Number.isFinite(args.index) && lastAxElements[args.index]) {
    const el = lastAxElements[args.index];
    return { x: el.cx, y: el.cy, label: el.label, role: el.role };
  }
  if (typeof args.label === "string" && args.label.trim()) {
    const needle = args.label.trim().toLowerCase();
    const el =
      lastAxElements.find((e) => e.label.toLowerCase() === needle) ||
      lastAxElements.find((e) => e.label.toLowerCase().includes(needle));
    if (el) return { x: el.cx, y: el.cy, label: el.label, role: el.role };
  }
  if (Number.isFinite(args.xNorm) && Number.isFinite(args.yNorm)) {
    return { x: Math.round(args.xNorm * logical.width), y: Math.round(args.yNorm * logical.height), label: "", role: "" };
  }
  if (Number.isFinite(args.x) && Number.isFinite(args.y)) {
    return { x: Math.round(args.x), y: Math.round(args.y), label: "", role: "" };
  }
  return null;
}

// Borrow the label of whatever AX element sits under a point, so a click given by
// raw/normalized coordinates still gets the same destructive-label safety check as
// a click given by index/label. This closes the "click the Send button by pixels" bypass.
function nearestLabel(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return "";
  let best = "";
  let bestDist = Infinity;
  for (const el of lastAxElements) {
    if (!el.label) continue;
    const inside = x >= el.x && x <= el.x + el.w && y >= el.y && y <= el.y + el.h;
    if (inside) return el.label;
    const dist = Math.hypot((el.cx ?? el.x) - x, (el.cy ?? el.y) - y);
    if (dist < 24 && dist < bestDist) {
      bestDist = dist;
      best = el.label;
    }
  }
  return best;
}

const normalizeLabel = (s) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Returns a human description if the action is potentially destructive, else null.
function actionDestructiveLabel(action, target) {
  if (action.type === "click") {
    const label = (target && target.label) || nearestLabel(target && target.x, target && target.y);
    return DESTRUCTIVE.test(label) ? label || "this control" : null;
  }
  if (action.type === "key") {
    const combo = String(action.combo || "").toLowerCase().replace(/\s+/g, "");
    if (/cmd\+(shift\+)?(delete|backspace)/.test(combo)) return `shortcut ${action.combo}`;
    return null;
  }
  return null;
}

function confirmMatches(destructiveLabel, confirmTarget) {
  const a = normalizeLabel(destructiveLabel);
  const b = normalizeLabel(confirmTarget);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// DOM browser agent — the precise path for web tasks (act on element refs, not pixels).
// Runs in a dedicated isolated profile; headful by default so the user can watch/log in.
let browserAgent = null;
function getBrowserAgent() {
  if (!browserAgent) {
    browserAgent = createBrowserAgent({
      profileDir: path.join(app.getPath("userData"), "browser-profile"),
      headless: process.env.RICKY_BROWSER_HEADLESS === "1",
      callVision,
      pushArtifact,
      pushTranscript,
      isDestructive: (s) => DESTRUCTIVE.test(String(s || "")),
      confirmMatches,
      sleep,
    });
  }
  return browserAgent;
}

const COMPUTER_PRIMITIVES = new Set([
  "computer_open_app",
  "computer_see",
  "computer_inspect",
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_scroll",
  "computer_move",
]);

function setClipboard(text) {
  return new Promise((resolve, reject) => {
    const proc = execFile("pbcopy", (error) => (error ? reject(error) : resolve()));
    proc.stdin.end(String(text));
  });
}

async function getClipboard() {
  const { stdout } = await execFileAsync("pbpaste", [], { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

// ---------------------------------------------------------------------------
// Tier 2: the computer-use agent loop. The voice model delegates a whole task
// here; this runs an observe -> plan -> act -> verify cycle with a vision model,
// grounded on Accessibility geometry, with host-enforced confirmation on
// destructive clicks. Progress streams to the UI live.
// ---------------------------------------------------------------------------

const PLANNER_SYSTEM = `You are Ricky's computer-use planner. You drive a real macOS screen to accomplish a goal.
Each step you receive a screenshot and a list of accessible UI elements, each with an index and center coordinates.
Respond with STRICT JSON only, no prose:
{"thought":"<one short line>","done":<bool>,"say":"<summary, only when done>","action":<action object or null>}
Action shapes:
- {"type":"click","index":N}                    click a listed element (PREFERRED — most reliable)
- {"type":"click","xNorm":0.0,"yNorm":0.0,"button":"left","double":false}   fraction of screen when no element fits
- {"type":"type","text":"...","paste":false,"submit":false}   submit=true presses Return afterward
- {"type":"key","combo":"cmd+t"}                 modifiers cmd/opt/ctrl/shift plus a key
- {"type":"scroll","direction":"up|down|left|right","amount":5}
- {"type":"open_app","app":"Safari"}
- {"type":"wait","ms":800}
Rules: prefer clicking by index; take ONE action per step; after each action re-read the next screenshot before continuing.
Set done=true with a short 'say' the moment the goal is satisfied. Never claim success you cannot see — verify visually.`;

function taskArtifact(goal, history, result) {
  return {
    title: "Computer task",
    kind: "markdown",
    content: `# ${goal}\n\n${history.map((h) => `- ${h}`).join("\n") || "- (no steps)"}\n\n**Result:** ${result}`,
  };
}

async function execAction(action, logical) {
  const type = String(action.type || "");
  if (type === "open_app") {
    await execFileAsync("open", ["-a", String(action.app || action.appName || "")]);
    await sleep(800);
    return `opened ${action.app || action.appName || "app"}`;
  }
  if (type === "type") {
    const text = String(action.text || "");
    if (action.paste) {
      await setClipboard(text);
      await bridge("key", "cmd+v");
    } else {
      await bridge("type", text);
    }
    if (action.submit) await bridge("key", "return");
    return `typed "${text.slice(0, 60)}"${action.submit ? " + return" : ""}`;
  }
  if (type === "key") {
    const combo = String(action.combo || action.key || "");
    await bridge("key", combo);
    return `pressed ${combo}`;
  }
  if (type === "scroll") {
    const amount = Math.max(1, Math.min(50, Number(action.amount || 5)));
    const map = { up: [0, amount], down: [0, -amount], left: [amount, 0], right: [-amount, 0] };
    const [dx, dy] = map[String(action.direction || "down")] || [0, -amount];
    await bridge("scroll", dx, dy);
    return `scrolled ${action.direction || "down"}`;
  }
  if (type === "click") {
    const target = resolveTarget(action, logical);
    if (!target) throw new Error("click target could not be resolved");
    const count = action.double ? 2 : 1;
    await bridge("click", target.x, target.y, count, action.button === "right" ? "right" : "left");
    return `clicked ${target.label || `${target.x},${target.y}`}`;
  }
  if (type === "wait") {
    await sleep(Math.min(4000, Number(action.ms || 800)));
    return "waited";
  }
  throw new Error(`unknown action: ${type}`);
}

async function runComputerTask(goal, { maxSteps = 12, confirmTarget = "" } = {}) {
  if (!goal.trim()) return { ok: false, error: "No goal was given for the task." };

  // Nothing works without both permissions (CGEvent clicks and AX reads need
  // Accessibility; screenshots need Screen Recording). Fail clearly up front rather
  // than silently no-op'ing every step, and don't shrink the window if we can't act.
  const perms = await bridgePermissions();
  const missing = [
    !perms.accessibility && "Accessibility",
    !perms.screenRecording && "Screen Recording",
  ].filter(Boolean);
  if (missing.length) {
    bridge("permprompt").catch(() => {}); // surface the macOS grant dialogs
    const list = missing.join(" and ");
    return {
      ok: false,
      requiresPermission: true,
      error: `I need ${list} permission to control the screen. Enable it in System Settings → Privacy & Security → ${missing.join(" and → ")}, then ask me again.`,
    };
  }

  // Enter computer mode so the mini face shows and the big window is out of the way.
  taskCancelRequested = false;
  currentMode = "computer";
  setWindowMode("computer");
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("ricky:set-mode", "computer");

  const logical = await displayInfo();
  const history = [];
  pushTranscript("tool", `Starting task: ${goal}`);

  for (let step = 1; step <= maxSteps; step += 1) {
    if (taskCancelRequested) {
      pushTranscript("tool", "Stopped by user.");
      return { ok: true, steps: step - 1, summary: "Stopped by the user.", artifact: taskArtifact(goal, history, "Stopped by the user.") };
    }
    let dump = { elements: [], app: "", window: "" };
    try {
      dump = await bridge("axdump", 160);
    } catch {
      /* AX may be unavailable; vision coordinates still work */
    }
    lastAxElements = Array.isArray(dump.elements) ? dump.elements : [];

    const shot = await captureScreen();
    pushArtifact({ title: `Task · step ${step}`, kind: "image", content: shot.dataUrl });

    const messages = [
      { role: "system", content: PLANNER_SYSTEM },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Goal: ${goal}\n` +
              `Step ${step} of ${maxSteps}\n` +
              `Front app: ${dump.app || "unknown"}${dump.window ? ` — ${dump.window}` : ""}\n\n` +
              `Accessible elements (click by index when possible):\n${axSummary(lastAxElements)}${dump.truncated ? "\n(list truncated — scroll for more)" : ""}\n\n` +
              `Recent actions:\n${history.slice(-6).map((h) => `- ${h}`).join("\n") || "(none yet)"}\n\n` +
              `Decide the single next action. Respond with JSON only.`,
          },
          { type: "image_url", image_url: { url: shot.dataUrl } },
        ],
      },
    ];

    let plan;
    try {
      plan = JSON.parse(await callVision(messages, { json: true }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushTranscript("tool", `Planner error: ${message}`);
      return { ok: false, error: `Planner error: ${message}` };
    }

    if (plan.thought) pushTranscript("tool", `Step ${step}: ${plan.thought}`);

    if (plan.done === true) {
      const summary = plan.say || "Task complete.";
      pushTranscript("tool", `Done: ${summary}`);
      return { ok: true, steps: step, summary, artifact: taskArtifact(goal, history, summary) };
    }

    if (!plan.action || typeof plan.action !== "object") {
      history.push("(no action returned)");
      continue;
    }

    // Host-enforced safety: a destructive click/shortcut (send/delete/pay/trash) pauses
    // for confirmation unless THIS specific target was already approved. Coordinate and
    // index clicks borrow the underlying element's label, so pixels can't dodge the gate.
    const target = plan.action.type === "click" ? resolveTarget(plan.action, logical) : null;
    const destructive = actionDestructiveLabel(plan.action, target);
    if (destructive && !confirmMatches(destructive, confirmTarget)) {
      pushTranscript("tool", `Paused — needs confirmation to ${plan.action.type === "click" ? "click" : "use"} "${destructive}".`);
      return {
        ok: false,
        requiresConfirmation: true,
        pendingTarget: destructive,
        message: `To continue "${goal}", Ricky needs to ${plan.action.type === "click" ? "click" : "use"} "${destructive}", which looks destructive (send/delete/pay/trash). Ask the user to confirm out loud; if they approve, call computer_task again with the same goal and confirmTarget set to exactly "${destructive}".`,
        artifact: { title: "Confirm action", kind: "progress", content: `Pending: ${destructive}` },
      };
    }

    try {
      const result = await execAction(plan.action, logical);
      history.push(result);
      pushTranscript("tool", result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      history.push(`error: ${message}`);
      pushTranscript("tool", `Action error: ${message}`);
    }
    await sleep(550);
  }

  return {
    ok: true,
    steps: maxSteps,
    summary: `Stopped at the ${maxSteps}-step limit before finishing.`,
    artifact: taskArtifact(goal, history, `Stopped at the ${maxSteps}-step limit.`),
  };
}

async function createWindow() {
  await ensureData();
  await clearStartupLoadingThumbnails();
  const win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 420,
    minHeight: 520,
    title: "Ricky",
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    icon: nativeImage.createEmpty(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;

  win.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    await win.loadURL(devUrl);
  } else {
    await win.loadFile(path.join(process.cwd(), "dist", "index.html"));
  }

  // Surface the macOS Accessibility + Screen Recording dialogs on first launch so
  // computer use works without the user hunting through System Settings. Best-effort:
  // silently ignored if the native bridge isn't built yet.
  bridgePermissions()
    .then((perms) => {
      if (!perms.accessibility || !perms.screenRecording) return bridge("permprompt");
    })
    .catch(() => {});
}

function setWindowMode(mode) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (mode === "computer") {
    const currentBounds = mainWindow.getBounds();
    if (currentBounds.width > 400 && currentBounds.height > 400) {
      normalWindowBounds = currentBounds;
    }
    const cursorPoint = screen.getCursorScreenPoint();
    const targetDisplay = screen.getDisplayNearestPoint(cursorPoint) || screen.getDisplayMatching(currentBounds);
    const { workArea } = targetDisplay;
    const miniSize = 190;
    const margin = 18;
    mainWindow.setMinimumSize(150, 150);
    mainWindow.setResizable(false);
    mainWindow.setAlwaysOnTop(true, "floating");
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    mainWindow.setBounds({
      x: workArea.x + margin,
      y: workArea.y + workArea.height - miniSize - margin,
      width: miniSize,
      height: miniSize,
    });
    return;
  }

  mainWindow.setAlwaysOnTop(false);
  mainWindow.setVisibleOnAllWorkspaces(false);
  mainWindow.setResizable(true);
  mainWindow.setMinimumSize(420, 520);
  if (normalWindowBounds) {
    mainWindow.setBounds(normalWindowBounds);
  } else {
    mainWindow.setBounds({ width: 1120, height: 760 });
    mainWindow.center();
  }
}

ipcMain.handle("tools:list", () => toolSpecs);

ipcMain.handle("realtime:create-token", async () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing in .env.local");
  }
  const db = await readDb();
  const instructions = `${RICKY_INSTRUCTIONS}\n\n${buildThumbnailBoardInstructions(db)}`;

  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": crypto.createHash("sha256").update("riley-local-ricky").digest("hex"),
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: "gpt-realtime-2",
        instructions,
        output_modalities: ["audio"],
        reasoning: { effort: "low" },
        tool_choice: "auto",
        tools: toolSpecs,
        audio: {
          input: {
            turn_detection: {
              type: "semantic_vad",
              eagerness: "medium",
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            voice: "cedar",
          },
        },
        tracing: {
          workflow_name: "Ricky Desktop Companion",
        },
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Realtime token request failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  const value = data.value || data.client_secret?.value;
  if (!value) {
    throw new Error("Realtime token response did not include a client secret value.");
  }
  return { value, expiresAt: data.expires_at || data.client_secret?.expires_at || null };
});

ipcMain.handle("tools:execute", async (_event, toolCall) => {
  const name = String(toolCall?.name || "");
  const args = asObject(toolCall?.arguments);

  try {
    if (name === "set_mode") {
      currentMode = args.mode === "computer" ? "computer" : "display";
      // Switching back to display is also the user's "stop" for an in-flight task.
      if (currentMode === "display") taskCancelRequested = true;
      setWindowMode(currentMode);
      return {
        ok: true,
        mode: currentMode,
        artifact: {
          title: "Ricky Mode",
          kind: "progress",
          content: `Mode switched to ${currentMode === "computer" ? "computer use" : "display"} mode.`,
        },
      };
    }

    if (name === "artifact_show") {
      return { ok: true, artifact: args };
    }

    if (name === "show_menu") {
      return {
        ok: true,
        artifact: {
          title: "Ricky Menu",
          kind: "markdown",
          content: buildMenuMarkdown(),
        },
      };
    }

    if (name === "web_search") {
      return await webSearch(args);
    }

    if (name === "image_generate") {
      return await generateImage(args);
    }

    if (name === "thumbnail_loading_prepare") {
      return await thumbnailLoadingPrepare(args);
    }

    if (name === "thumbnail_reference_add") {
      return await thumbnailReferenceAdd(args);
    }

    if (name === "thumbnail_generate") {
      return await thumbnailGenerate(args);
    }

    if (name === "thumbnail_edit") {
      return await thumbnailEdit(args);
    }

    if (name === "thumbnail_select") {
      return await thumbnailSelect(args);
    }

    if (name === "thumbnail_grid") {
      const { db } = await updateDb(async (currentDb) => {
        currentDb.thumbnailBoard.view = "grid";
        currentDb.thumbnailBoard.page = pageForArgs(args);
      });
      return { ok: true, board: thumbnailBoardSummary(db), artifact: await thumbnailBoardArtifact(db, "grid") };
    }

    if (name === "mermaid_render") {
      const diagram = normalizeMermaidDiagram(String(args.diagram || ""), String(args.title || "Mermaid chart"));
      return {
        ok: true,
        artifact: {
          title: String(args.title || "Mermaid chart"),
          kind: "mermaid",
          content: diagram,
        },
      };
    }

    if (name === "note_add") {
      const db = await readDb();
      const note = {
        id: crypto.randomUUID(),
        text: String(args.text || ""),
        tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
        createdAt: new Date().toISOString(),
      };
      db.notes.unshift(note);
      await writeDb(db);
      return {
        ok: true,
        note,
        artifact: {
          title: "Fun Notes",
          kind: "notes",
          content: JSON.stringify(db.notes.slice(0, 20), null, 2),
        },
      };
    }

    if (name === "records_create") {
      const db = await readDb();
      const record = {
        id: crypto.randomUUID(),
        collection: String(args.collection || "default"),
        title: String(args.title || "Untitled"),
        fields: asObject(args.fields),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      db.records.unshift(record);
      await writeDb(db);
      return { ok: true, record, artifact: recordsArtifact(db.records, record.collection) };
    }

    if (name === "records_search") {
      const db = await readDb();
      const collection = String(args.collection || "default");
      const query = String(args.query || "").toLowerCase();
      const records = db.records.filter((record) => {
        if (record.collection !== collection) return false;
        if (!query) return true;
        return JSON.stringify(record).toLowerCase().includes(query);
      });
      return { ok: true, records, artifact: recordsArtifact(records, collection) };
    }

    if (name === "records_update") {
      const db = await readDb();
      const record = db.records.find((item) => item.id === args.id);
      if (!record) return { ok: false, error: "Record not found." };
      record.title = typeof args.title === "string" ? args.title : record.title;
      record.fields = { ...record.fields, ...asObject(args.fields) };
      record.updatedAt = new Date().toISOString();
      await writeDb(db);
      return { ok: true, record, artifact: recordsArtifact(db.records, record.collection) };
    }

    if (name === "records_delete") {
      if (args.confirmed !== true) {
        return { ok: false, requiresConfirmation: true, message: "Explicit confirmation is required before deleting a record." };
      }
      const db = await readDb();
      const before = db.records.length;
      db.records = db.records.filter((record) => record.id !== args.id);
      await writeDb(db);
      return { ok: true, deleted: before !== db.records.length, artifact: recordsArtifact(db.records, "All Records") };
    }

    if (name === "clipboard_read") {
      const text = await getClipboard();
      return { ok: true, text, artifact: { title: "Clipboard", kind: "text", content: text.slice(0, 4000) || "(clipboard is empty)" } };
    }

    if (name === "clipboard_write") {
      await setClipboard(String(args.text || ""));
      return { ok: true, message: "Copied to the clipboard." };
    }

    if (name === "browser_task") {
      return await getBrowserAgent().runBrowserTask(String(args.goal || ""), {
        maxSteps: Math.max(1, Math.min(30, Number(args.maxSteps || 14))),
        confirmTarget: String(args.confirmTarget || ""),
      });
    }

    if (name === "browser_open") {
      return await getBrowserAgent().openUrl(String(args.url || ""));
    }

    if (name === "browser_read") {
      return await getBrowserAgent().readPage();
    }

    if (name === "computer_task") {
      return await runComputerTask(String(args.goal || ""), {
        maxSteps: Math.max(1, Math.min(30, Number(args.maxSteps || 12))),
        confirmTarget: String(args.confirmTarget || ""),
      });
    }

    // Direct primitives require computer mode. computer_task enters it on its own.
    if (COMPUTER_PRIMITIVES.has(name)) {
      const blocked = requireComputerMode();
      if (blocked) return blocked;
    }

    if (name === "computer_open_app") {
      await execFileAsync("open", ["-a", String(args.appName || "")]);
      await sleep(700);
      return { ok: true, message: `Opened ${args.appName}.` };
    }

    if (name === "computer_see") {
      const shot = await captureScreen();
      pushArtifact({ title: "Screen", kind: "image", content: shot.dataUrl });
      const question = String(args.question || "").trim();
      const description = await callVision([
        {
          role: "system",
          content:
            "You are Ricky's eyes on the user's macOS screen. Describe what is visible concisely and, if asked, answer the question. Name the frontmost app, key windows, buttons, fields, and any obvious state. Max 4 sentences.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: question ? `Look at my screen. ${question}` : "What is on my screen right now?" },
            { type: "image_url", image_url: { url: shot.dataUrl } },
          ],
        },
      ]);
      return { ok: true, description, artifact: { title: "Screen", kind: "image", content: shot.dataUrl } };
    }

    if (name === "computer_inspect") {
      const dump = await bridge("axdump", 200);
      lastAxElements = Array.isArray(dump.elements) ? dump.elements : [];
      const summary =
        axSummary(lastAxElements) +
        (dump.truncated ? "\n(list truncated — more elements exist; scroll or ask again after narrowing)" : "");
      return {
        ok: true,
        app: dump.app,
        window: dump.window,
        count: lastAxElements.length,
        truncated: dump.truncated === true,
        elements: summary,
        artifact: {
          title: `UI: ${dump.app || "frontmost app"}`,
          kind: "text",
          content: `${dump.app || "?"}${dump.window ? ` — ${dump.window}` : ""}\n\n${summary}`,
        },
      };
    }

    if (name === "computer_click") {
      const logical = await displayInfo();
      const target = resolveTarget(args, logical);
      if (!target) {
        return { ok: false, error: "No click target. Give index (from computer_inspect), label, x/y, or xNorm/yNorm." };
      }
      const effectiveLabel = target.label || nearestLabel(target.x, target.y);
      const risky =
        args.confirmed !== true &&
        (DESTRUCTIVE.test(effectiveLabel) || args.risk === "may_send_or_modify" || args.risk === "private_or_sensitive");
      if (risky) {
        return {
          ok: false,
          requiresConfirmation: true,
          message: `About to click ${effectiveLabel ? `"${effectiveLabel}"` : `(${target.x}, ${target.y})`}, which may be destructive. Confirm first.`,
        };
      }
      const count = args.double === true ? 2 : 1;
      await bridge("click", target.x, target.y, count, args.button === "right" ? "right" : "left");
      return { ok: true, message: `Clicked ${effectiveLabel ? `"${effectiveLabel}"` : `${target.x}, ${target.y}`}.` };
    }

    if (name === "computer_type") {
      const text = String(args.text || "");
      if (args.paste === true) {
        await setClipboard(text);
        await bridge("key", "cmd+v");
      } else {
        await bridge("type", text);
      }
      if (args.submit === true) await bridge("key", "return");
      return { ok: true, message: `Typed ${text.length} characters${args.submit === true ? " and pressed Return" : ""}.` };
    }

    if (name === "computer_key") {
      const combo = String(args.combo || args.key || "").trim();
      if (!combo) return { ok: false, error: "No key combo given." };
      const repeat = Math.max(1, Math.min(20, Number(args.repeat || 1)));
      for (let i = 0; i < repeat; i += 1) await bridge("key", combo);
      return { ok: true, message: `Pressed ${combo}${repeat > 1 ? ` ×${repeat}` : ""}.` };
    }

    if (name === "computer_scroll") {
      const amount = Math.max(1, Math.min(50, Number(args.amount || 5)));
      const map = { up: [0, amount], down: [0, -amount], left: [amount, 0], right: [-amount, 0] };
      const [dx, dy] = map[String(args.direction || "down")] || [0, -amount];
      await bridge("scroll", dx, dy);
      return { ok: true, message: `Scrolled ${args.direction || "down"}.` };
    }

    if (name === "computer_move") {
      const logical = await displayInfo();
      const target = resolveTarget(args, logical);
      if (!target) return { ok: false, error: "No move target." };
      await bridge("move", target.x, target.y);
      return { ok: true, message: `Moved cursor to ${target.x}, ${target.y}.` };
    }

    return { ok: false, error: `Unknown tool: ${name}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

async function webSearch(args) {
  const exaKey = process.env.EXA_API_KEY;
  if (!exaKey) {
    return {
      ok: false,
      missingEnv: "EXA_API_KEY",
      message: "EXA_API_KEY is not set. Add it to .env.local to enable Ricky's web search tool.",
    };
  }

  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": exaKey,
    },
    body: JSON.stringify({
      query: String(args.query || ""),
      type: "auto",
      numResults: Math.max(1, Math.min(10, Number(args.numResults || 5))),
      contents: { text: { maxCharacters: 900 } },
    }),
  });

  if (!response.ok) {
    return { ok: false, error: `Exa search failed: ${response.status} ${await response.text()}` };
  }
  const data = await response.json();
  const results = Array.isArray(data.results) ? data.results : [];
  return {
    ok: true,
    results,
    artifact: {
      title: `Web Search: ${args.query}`,
      kind: "markdown",
      content: formatSearchMarkdown(String(args.query || ""), results),
    },
  };
}

function formatSearchMarkdown(query, results) {
  const cleanQuery = query.trim() || "Search";
  if (results.length === 0) {
    return `# ${cleanQuery}\n\nNo strong web results came back for this search. Try a narrower query or ask Ricky to search a specific site.`;
  }

  const sections = results.slice(0, 8).map((result, index) => {
    const title = cleanMarkdownText(result.title || result.url || `Result ${index + 1}`);
    const url = String(result.url || "");
    const source = cleanMarkdownText(result.author || hostname(url) || "Source");
    const text = cleanMarkdownText(result.text || result.summary || "").slice(0, 700);
    const published = result.publishedDate ? `\n- Published: ${cleanMarkdownText(result.publishedDate)}` : "";
    const link = url ? `[Open source](${url})` : "Source link unavailable";

    return `### ${index + 1}. ${title}\n\n${text || "No snippet was returned for this result."}\n\n- Source: ${source}${published}\n- ${link}`;
  });

  return [`# ${cleanQuery}`, `Ricky found ${results.length} source${results.length === 1 ? "" : "s"}.`, ...sections].join(
    "\n\n",
  );
}

function cleanMarkdownText(value) {
  return String(value)
    .replace(/\s+/g, " ")
    .replace(/[<>]/g, "")
    .trim();
}

function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function buildMenuMarkdown() {
  return `# Ricky Menu

Here is what you can ask me to do.

## Voice and Conversation

- Talk naturally with Ricky in realtime.
- Interrupt mid-response and ask follow-ups.
- Ask unrelated questions while tools keep running.

## Artifacts Panel

- "Show me the menu."
- "Show the artifacts panel."
- "Make that fullscreen."
- Show clean research briefs, notes, code snippets, charts, task progress, images, and records.

## Web and Research

- "Search the web for ..."
- "Look up the latest on ..."
- Results render as a clean Markdown brief with source links.

## Visuals

- Generate images with GPT Image.
- Create Mermaid charts with automatic fallback if the syntax breaks.
- Draft diagrams, code snippets, structured notes, and visual explanations.

## Notes and Records

- Add notes to Ricky's local note grid.
- Create, search, update, and confirm-delete local database records.

## Computer Use

- "Open Safari and search for the latest AI video tools." — Ricky drives the screen itself, step by step.
- "What's on my screen right now?" — Ricky looks and tells you.
- "Reply to the top email and say I'll be there at noon."
- Behind the scenes: Ricky sees the screen, reads the actual on-screen elements, then clicks, types, uses shortcuts, and scrolls with a real cursor — verifying each step.
- Ricky pauses for your OK before anything destructive: sending, deleting, buying, or changing settings.

## Good Starter Prompts

- "Show me the menu."
- "Search the web for the latest AI video tools."
- "Create a chart of my workflow."
- "Open Notes and start a new note titled Ideas."
- "Look at my screen and tell me what that error says."`;
}

async function generateImage(args) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return imageErrorArtifact("OPENAI_API_KEY is missing in .env.local.");
  }

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-2",
      prompt: String(args.prompt || ""),
      size: String(args.size || "1024x1024"),
      quality: "medium",
    }),
  });

  if (!response.ok) {
    return imageErrorArtifact(`Image generation failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const b64 = data.data?.[0]?.b64_json;
  const url = data.data?.[0]?.url;
  if (b64) {
    await fs.mkdir(dataDir, { recursive: true });
    const imagePath = path.join(dataDir, `ricky-image-${Date.now()}.png`);
    await fs.writeFile(imagePath, Buffer.from(b64, "base64"));
    return {
      ok: true,
      path: imagePath,
      artifact: {
        title: "Generated Image",
        kind: "image",
        content: `data:image/png;base64,${b64}`,
      },
    };
  }
  if (url) {
    return { ok: true, url, artifact: { title: "Generated Image", kind: "image", content: url } };
  }
  return imageErrorArtifact("Image response did not include image data.");
}

function imageErrorArtifact(error) {
  return {
    ok: false,
    error,
    artifact: {
      title: "Image Generation Failed",
      kind: "markdown",
      content: `# Image generation failed\n\n${cleanMarkdownText(error)}\n\nTry a shorter prompt, a different size, or check model access for \`gpt-image-2\`.`,
    },
  };
}

async function thumbnailReferenceAdd(args) {
  const imagePath = path.resolve(String(args.imagePath || "").replace(/^file:\/\//, ""));
  try {
    await fs.access(imagePath);
  } catch {
    return imageErrorArtifact(`Reference image not found: ${imagePath}`);
  }

  const db = await readDb();
  const reference = {
    id: crypto.randomUUID(),
    path: imagePath,
    label: String(args.label || path.basename(imagePath)),
    createdAt: new Date().toISOString(),
  };
  db.thumbnailBoard.references.unshift(reference);
  await writeDb(db);
  return {
    ok: true,
    reference,
    board: thumbnailBoardSummary(db),
    artifact: await thumbnailBoardArtifact(db, "grid"),
    message: `Added ${reference.label} as a thumbnail reference image.`,
  };
}

async function thumbnailLoadingPrepare(args) {
  const runId = crypto.randomUUID();
  const count = 1;
  const mode = args.mode === "edit" ? "edited" : "generated";
  let target = null;
  const { db } = await updateDb(async (currentDb) => {
    target = mode === "edited" ? thumbnailByNumberOrSelected(currentDb, args.number, args.targetId) : null;
    const placeholders = Array.from({ length: count }, (_unused, index) => ({
      id: crypto.randomUUID(),
      number: currentDb.thumbnailBoard.nextNumber++,
      runId,
      status: "loading",
      type: mode,
      prompt: String(args.prompt || ""),
      size: "1536x1024",
      parentId: target?.id || null,
      createdAt: new Date().toISOString(),
      loadingLabel: count > 1 ? `Generating ${index + 1}/${count}` : mode === "edited" ? "Editing" : "Generating",
    }));

    currentDb.thumbnailBoard.images.unshift(...placeholders);
    if (currentDb.thumbnailBoard.view !== "selected" || !currentDb.thumbnailBoard.selectedId) {
      currentDb.thumbnailBoard.selectedId = null;
      currentDb.thumbnailBoard.view = "grid";
      currentDb.thumbnailBoard.page = 1;
    }
  });
  const view = db.thumbnailBoard.view === "selected" && db.thumbnailBoard.selectedId ? "selected" : "grid";
  return {
    ok: true,
    runId,
    targetId: target?.id || null,
    board: thumbnailBoardSummary(db),
    artifact: await thumbnailBoardArtifact(db, view),
  };
}

async function thumbnailGenerate(args) {
  try {
    const db = await readDb();
    const prompt = thumbnailPrompt(String(args.prompt || ""), db.thumbnailBoard.references.length > 0);
    const size = "1536x1024";
    const count = 1;
    const referencePaths = db.thumbnailBoard.references.map((reference) => reference.path).slice(0, 4);

    const generated = await Promise.all(
      Array.from({ length: count }, async (_unused, index) => {
        const image = await createThumbnailImage({
          prompt,
          size,
          inputPaths: referencePaths,
        });
        return thumbnailRecord(image, args.prompt, "generated", size);
      }),
    );

    const { db: latestDb } = await updateDb(async (currentDb) => {
      replaceLoadingThumbnails(currentDb, args.runId, generated);
      if (currentDb.thumbnailBoard.view !== "selected" || !currentDb.thumbnailBoard.selectedId) {
        currentDb.thumbnailBoard.selectedId = null;
        currentDb.thumbnailBoard.view = "grid";
        currentDb.thumbnailBoard.page = 1;
      }
    });
    const view = latestDb.thumbnailBoard.view === "selected" && latestDb.thumbnailBoard.selectedId ? "selected" : "grid";
    return {
      ok: true,
      count: generated.length,
      board: thumbnailBoardSummary(latestDb),
      artifact: await thumbnailBoardArtifact(latestDb, view),
      silent: true,
      thumbnailReady: true,
    };
  } catch (error) {
    if (args.runId) await removeLoadingThumbnailRun(args.runId);
    return imageErrorArtifact(error instanceof Error ? error.message : String(error));
  }
}

async function thumbnailEdit(args) {
  try {
    const db = await readDb();
    const target = thumbnailByNumberOrSelected(db, args.number, args.targetId);
    if (!target) {
      return imageErrorArtifact("No thumbnail is selected. Say a number, like 'edit number two', or generate a thumbnail first.");
    }

    const size = "1536x1024";
    const count = 1;
    const referencePaths = db.thumbnailBoard.references.map((reference) => reference.path).slice(0, 3);
    const inputPaths = [target.path, ...referencePaths].filter(Boolean);
    const editPrompt = editThumbnailPrompt(String(args.prompt || ""), target.prompt || "");

    const edited = await Promise.all(
      Array.from({ length: count }, async (_unused, index) => {
        const image = await createThumbnailImage({
          prompt: editPrompt,
          size,
          inputPaths,
        });
        return {
          ...thumbnailRecord(image, args.prompt, "edited", size),
          parentId: target.id,
        };
      }),
    );

    const { db: latestDb } = await updateDb(async (currentDb) => {
      replaceLoadingThumbnails(currentDb, args.runId, edited);
      if (currentDb.thumbnailBoard.view !== "selected" || !currentDb.thumbnailBoard.selectedId) {
        currentDb.thumbnailBoard.selectedId = null;
        currentDb.thumbnailBoard.view = "grid";
        currentDb.thumbnailBoard.page = 1;
      }
    });
    const view = latestDb.thumbnailBoard.view === "selected" && latestDb.thumbnailBoard.selectedId ? "selected" : "grid";
    return {
      ok: true,
      count: edited.length,
      board: thumbnailBoardSummary(latestDb),
      artifact: await thumbnailBoardArtifact(latestDb, view),
      silent: true,
      thumbnailReady: true,
    };
  } catch (error) {
    if (args.runId) await removeLoadingThumbnailRun(args.runId);
    return imageErrorArtifact(error instanceof Error ? error.message : String(error));
  }
}

async function thumbnailSelect(args) {
  const db = await readDb();
  const number = Number(args.number || 0);
  const selected = db.thumbnailBoard.images.find((image) => image.number === number);
  if (!selected) {
    return imageErrorArtifact(`Thumbnail number ${number} does not exist yet.`);
  }
  if (selected.status === "loading") {
    return imageErrorArtifact(`Thumbnail number ${number} is still generating.`);
  }
  db.thumbnailBoard.selectedId = selected.id;
  db.thumbnailBoard.view = "selected";
  await writeDb(db);
  return {
    ok: true,
    selected,
    selectedNumber: number,
    board: thumbnailBoardSummary(db),
    artifact: await thumbnailBoardArtifact(db, "selected"),
    message: `Selected thumbnail ${number}.`,
  };
}

async function createThumbnailImage({ prompt, size, inputPaths }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing in .env.local.");
  }

  if (inputPaths.length > 0) {
    return await editImageWithInputs({ apiKey, prompt, size, inputPaths });
  }

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-2",
      prompt,
      size,
      quality: "medium",
    }),
  });

  if (!response.ok) {
    throw new Error(`Thumbnail generation failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return await saveImageResponse(data, "thumbnail");
}

async function editImageWithInputs({ apiKey, prompt, size, inputPaths }) {
  const buildForm = async (imageFieldName) => {
    const form = new FormData();
    form.append("model", "gpt-image-2");
    form.append("prompt", prompt);
    form.append("size", size);
    form.append("quality", "medium");
    for (const inputPath of inputPaths.slice(0, 10)) {
      const buffer = await fs.readFile(inputPath);
      form.append(imageFieldName, new Blob([buffer], { type: mimeForPath(inputPath) }), path.basename(inputPath));
    }
    return form;
  };

  let response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: await buildForm("image[]"),
  });

  if (!response.ok) {
    const firstError = await response.text();
    response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: await buildForm("image"),
    });
    if (!response.ok) {
      throw new Error(`Thumbnail edit failed: ${response.status} ${await response.text() || firstError}`);
    }
  }

  const data = await response.json();
  return await saveImageResponse(data, "thumbnail");
}

async function saveImageResponse(data, prefix) {
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("Image response did not include image data.");
  }
  await fs.mkdir(dataDir, { recursive: true });
  const imagePath = path.join(dataDir, `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.png`);
  await fs.writeFile(imagePath, Buffer.from(b64, "base64"));
  return { path: imagePath, dataUrl: `data:image/png;base64,${b64}` };
}

function thumbnailRecord(image, prompt, type, size) {
  return {
    id: crypto.randomUUID(),
    type,
    path: image.path,
    prompt: String(prompt || ""),
    size,
    createdAt: new Date().toISOString(),
  };
}

function thumbnailPrompt(prompt, hasReferences) {
  return [
    hasReferences ? "Use the provided reference image(s) of Riley as the identity reference." : "",
    "Create one 16:9 YouTube thumbnail.",
    "Follow this request literally. Do not add extra concepts, fake UI, extra text, watermarks, or unrelated elements.",
    prompt,
  ]
    .filter(Boolean)
    .join("\n");
}

function editThumbnailPrompt(prompt, originalPrompt) {
  return [
    "Edit the provided thumbnail image.",
    "Make only this change. Preserve everything else unless the request says otherwise.",
    prompt,
  ]
    .filter(Boolean)
    .join("\n");
}

function thumbnailByNumberOrSelected(db, number, targetId) {
  const candidate = targetId
    ? db.thumbnailBoard.images.find((image) => image.id === targetId) || null
    : number
      ? db.thumbnailBoard.images.find((image) => image.number === Number(number)) || null
      : db.thumbnailBoard.selectedId
        ? db.thumbnailBoard.images.find((image) => image.id === db.thumbnailBoard.selectedId) || null
        : null;
  if (candidate?.status === "loading") return null;
  return candidate;
}

function replaceLoadingThumbnails(db, runId, records) {
  if (!runId) {
    db.thumbnailBoard.images.unshift(...records.map((record) => assignThumbnailNumber(db, record)));
    return;
  }

  const placeholders = db.thumbnailBoard.images
    .map((image, index) => ({ image, index }))
    .filter(({ image }) => image.runId === runId && image.status === "loading");

  if (placeholders.length === 0) {
    db.thumbnailBoard.images.unshift(...records.map((record) => assignThumbnailNumber(db, record)));
    return;
  }

  for (const [recordIndex, placeholder] of placeholders.entries()) {
    const replacement = records[recordIndex];
    if (replacement) db.thumbnailBoard.images[placeholder.index] = { ...replacement, number: placeholder.image.number };
  }

  if (records.length > placeholders.length) {
    db.thumbnailBoard.images.unshift(...records.slice(placeholders.length).map((record) => assignThumbnailNumber(db, record)));
  }
}

async function removeLoadingThumbnailRun(runId) {
  await updateDb(async (db) => {
    db.thumbnailBoard.images = db.thumbnailBoard.images.filter(
      (image) => !(image.runId === runId && image.status === "loading"),
    );
    db.thumbnailBoard.view = "grid";
    if (db.thumbnailBoard.selectedId && !db.thumbnailBoard.images.some((image) => image.id === db.thumbnailBoard.selectedId)) {
      db.thumbnailBoard.selectedId = null;
    }
  });
}

function thumbnailNumber(db, id) {
  return db.thumbnailBoard.images.find((image) => image.id === id)?.number || null;
}

function assignThumbnailNumber(db, image) {
  if (Number.isInteger(image.number) && image.number > 0) return image;
  return { ...image, number: db.thumbnailBoard.nextNumber++ };
}

function pageForArgs(args) {
  const page = Number(args?.page || 1);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function sortedThumbnailImages(db) {
  return [...db.thumbnailBoard.images].sort((a, b) => (b.number || 0) - (a.number || 0));
}

function paginatedThumbnailImages(db, page = db.thumbnailBoard.page || 1) {
  const pageSize = db.thumbnailBoard.pageSize || 9;
  const start = (page - 1) * pageSize;
  return sortedThumbnailImages(db).slice(start, start + pageSize);
}

function thumbnailPageMeta(db) {
  const pageSize = db.thumbnailBoard.pageSize || 9;
  const totalImages = db.thumbnailBoard.images.length;
  return {
    page: db.thumbnailBoard.page || 1,
    pageSize,
    totalImages,
    totalPages: Math.max(1, Math.ceil(totalImages / pageSize)),
    nextNumber: db.thumbnailBoard.nextNumber,
  };
}

function thumbnailBoardSummary(db) {
  const board = db.thumbnailBoard;
  const selectedNumber = board.selectedId ? thumbnailNumber(db, board.selectedId) : null;
  const page = thumbnailPageMeta(db);
  return {
    view: board.view,
    selectedNumber,
    references: board.references.length,
    page,
    images: paginatedThumbnailImages(db, page.page).map((image) => ({
      number: image.number,
      id: image.id,
      status: image.status === "loading" ? "loading" : "ready",
      type: image.type || "thumbnail",
      prompt: image.prompt || "",
    })),
  };
}

function buildThumbnailBoardInstructions(db) {
  const summary = thumbnailBoardSummary(db);
  const imageLines = summary.images.length
    ? summary.images
        .map((image) => `- #${image.number}: ${image.status}${image.status === "ready" ? `, ${image.type}` : ""}${image.prompt ? `, prompt: ${image.prompt.slice(0, 120)}` : ""}`)
        .join("\n")
    : "- No generated thumbnails yet.";

  return `# Current Thumbnail Board State
Reference images loaded: ${summary.references}
Current view: ${summary.view}
Selected thumbnail number: ${summary.selectedNumber || "none"}
Current page: ${summary.page.page}/${summary.page.totalPages}
Total thumbnails: ${summary.page.totalImages}
Next new thumbnail number: ${summary.page.nextNumber}
Visible permanent thumbnail numbers:
${imageLines}

When Riley says "pull up number N", "select N", or "show N", call thumbnail_select with that permanent number. When Riley says "edit this", use thumbnail_edit with no number if a selected thumbnail number exists. When Riley says "edit number N", call thumbnail_edit with that permanent number. When he asks for older thumbnails or another page, call thumbnail_grid with the requested page. Do not claim you cannot see prior thumbnails; this board state is persistent and paginated.`;
}

async function thumbnailBoardArtifact(db, view) {
  const board = db.thumbnailBoard;
  const selected = board.images.find((image) => image.id === board.selectedId) || null;
  const page = thumbnailPageMeta(db);
  const visibleImages = view === "selected" && selected ? [selected] : paginatedThumbnailImages(db, page.page);
  const images = await Promise.all(
    visibleImages.map(async (image) => {
      const src = image.path ? await imageDataUrl(image.path) : null;
      return {
        ...image,
        number: image.number,
        src,
        selected: selected?.id === image.id,
      };
    }),
  );

  return {
    title: view === "selected" && selected ? `Thumbnail ${thumbnailNumber(db, selected.id)}` : "Thumbnail Board",
    kind: "thumbnailBoard",
    fullscreen: view === "selected",
    content: JSON.stringify({
      view,
      selectedId: board.selectedId,
      references: board.references,
      page,
      images,
    }),
  };
}

async function imageDataUrl(imagePath) {
  const buffer = await fs.readFile(imagePath);
  return `data:${mimeForPath(imagePath)};base64,${buffer.toString("base64")}`;
}

function mimeForPath(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function recordsArtifact(records, collection) {
  return {
    title: `Records: ${collection}`,
    kind: "table",
    content: JSON.stringify(records, null, 2),
  };
}

function normalizeMermaidDiagram(diagram, title) {
  const stripped = diagram
    .replace(/```mermaid/gi, "")
    .replace(/```/g, "")
    .replace(/\r/g, "")
    .trim();

  if (!stripped) {
    return fallbackMermaidDiagram(title);
  }

  const lines = stripped
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/[–—]/g, "-")
        .replace(/\s+-->\s+/g, " --> ")
        .replace(/\s+---\s+/g, " --- "),
    );

  const hasDiagramHeader = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|mindmap|timeline)\b/i.test(
    lines[0] || "",
  );

  return hasDiagramHeader ? lines.join("\n") : `flowchart TD\n${lines.join("\n")}`;
}

function fallbackMermaidDiagram(title) {
  const safeTitle = String(title || "Chart").replace(/["<>]/g, "");
  return `flowchart TD\n  A["${safeTitle}"] --> B["Chart request received"]\n  B --> C["Ricky will show a safe fallback if syntax fails"]`;
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
