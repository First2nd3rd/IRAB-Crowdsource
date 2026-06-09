// Expert crowdsource server — zero external dependencies (Node built-in http).
//
//   node server.js            # serves on PORT (default 4321)
//
// Routes:
//   GET  /                    -> public/index.html
//   GET  /<asset>             -> static files under public/ (incl. report-assets)
//   GET  /api/tasks           -> { agent, featured:[full], poolIds:[...] }
//   GET  /api/task/:id        -> one full task (for randomly drawn pool questions)
//   POST /api/feedback        -> append one submission to data/feedback.jsonl
//   GET  /api/stats           -> submission count
//
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const FEEDBACK_FILE = path.join(DATA_DIR, "feedback.jsonl");
const PORT = Number(process.env.PORT) || 4321;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const BLIND_REACTIONS = new Set(["too_low", "reasonable", "too_high"]);
const VERDICTS = new Set(["reasonable", "unreasonable"]);
// Third option differs by level: rubric -> "没必要评", overall -> "维度有问题".
const OVERALL_TIGHTNESS = new Set(["too_strict", "too_lenient", "wrong_dimensions"]);
const RUBRIC_TIGHTNESS = new Set(["too_strict", "too_lenient", "unnecessary"]);
const MAX_NOTE = 5000;

// --- task data ---------------------------------------------------------------

function buildTask(t) {
  return {
    taskId: t.taskId,
    featured: !!t.featured,
    agent: t.agent,
    question: t.question,
    answer: t.answer || "", // fallback when report markdown is empty
    reportFileName: t.reportFileName,
    reportKind: t.reportKind || "markdown", // markdown | image | html | attachment
    attachmentPath: t.attachmentPath || "",
    report: t.report || "",
    overall: t.overall,
    rubrics: (t.rubrics || []).map((r) => ({
      rubricId: r.rubricId,
      name: r.name,
      value: r.value,
      verdict: r.verdict,
      weight: r.weight,
      kind: r.kind,
      summary: r.summaryZh || "", // primary, shown inline
      reasoning: r.reasoning || "", // full original, optional expand
    })),
  };
}

function loadData() {
  const finalPath = path.join(DATA_DIR, "tasks.json");
  const rawPath = path.join(DATA_DIR, "tasks.raw.json");
  const src = fs.existsSync(finalPath) ? finalPath : rawPath;
  const data = JSON.parse(fs.readFileSync(src, "utf8"));
  const byId = {};
  for (const t of data.tasks || []) byId[t.taskId] = buildTask(t);
  const featured = (data.tasks || []).filter((t) => t.featured).map((t) => t.taskId);
  const poolIds = (data.tasks || []).filter((t) => !t.featured).map((t) => t.taskId);
  return { agent: data.agent, byId, featured, poolIds, _source: path.basename(src) };
}

let DATA = null;
const data = () => (DATA ??= loadData());

// --- feedback append (serialized) --------------------------------------------
//
// Concurrent submissions are serialized through writeChain so JSONL lines never
// interleave. A failed write must NOT poison the chain: we keep the *tail* of the
// chain always-resolved (so the next writer still runs) while still returning the
// real per-write result to the caller (so a failure surfaces as a 400 to that
// user only, not silently dropped).
let writeTail = Promise.resolve();
async function doAppend(line) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.appendFile(FEEDBACK_FILE, line, "utf8");
}
function appendFeedback(record) {
  const line = JSON.stringify(record) + "\n";
  // Run after the previous write regardless of whether it succeeded or failed.
  const run = writeTail.then(() => doAppend(line), () => doAppend(line));
  // The chain's tail swallows errors so it can never get stuck in a rejected state.
  writeTail = run.catch(() => {});
  return run; // caller still observes this write's own success/failure
}

function countFeedback() {
  try {
    return fs.readFileSync(FEEDBACK_FILE, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

// What has this respondent already evaluated? Lets a returning expert skip the
// featured round instead of re-doing the same questions. Matched by name +
// institution (trimmed, exact). Small file → a full scan per call is fine.
function progressFor(name, institution) {
  const seen = new Set();
  let lastSessionId = null;
  let maxRound = 0;
  let submissions = 0;
  let lines = [];
  try {
    lines = fs.readFileSync(FEEDBACK_FILE, "utf8").split("\n").filter(Boolean);
  } catch {
    /* no file yet */
  }
  for (const l of lines) {
    let r;
    try {
      r = JSON.parse(l);
    } catch {
      continue;
    }
    const rn = (r.respondent?.name || "").trim();
    const ri = (r.respondent?.institution || "").trim();
    if (rn !== name || ri !== institution) continue;
    submissions += 1;
    if (typeof r.sessionId === "string") lastSessionId = r.sessionId;
    if (Number(r.round)) maxRound = Math.max(maxRound, Number(r.round));
    for (const resp of r.responses || []) if (resp?.taskId) seen.add(resp.taskId);
  }
  return { seen: [...seen], submissions, lastSessionId, maxRound };
}

// --- validation --------------------------------------------------------------

const isNonEmptyStr = (v, max = 200) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max;

function validateSubmission(body, validTaskIds) {
  if (!body || typeof body !== "object") return "invalid body";
  const r = body.respondent;
  if (!r || !isNonEmptyStr(r.name)) return "name required";
  if (!isNonEmptyStr(r.institution)) return "institution required";
  if (!Array.isArray(body.responses) || body.responses.length === 0) {
    return "responses required";
  }
  for (const resp of body.responses) {
    if (!resp || !validTaskIds.has(resp.taskId)) return "unknown taskId";
    if (!BLIND_REACTIONS.has(resp.blindReaction)) return "invalid blindReaction";
    if (!VERDICTS.has(resp.overallVerdict)) return "invalid overallVerdict";
    if (resp.overallTightness != null && !OVERALL_TIGHTNESS.has(resp.overallTightness)) {
      return "invalid overallTightness";
    }
    if (resp.perRubric && typeof resp.perRubric === "object") {
      for (const v of Object.values(resp.perRubric)) {
        if (v != null && !VERDICTS.has(v)) return "invalid perRubric verdict";
      }
    }
    if (resp.perRubricTightness && typeof resp.perRubricTightness === "object") {
      for (const v of Object.values(resp.perRubricTightness)) {
        if (v != null && !RUBRIC_TIGHTNESS.has(v)) return "invalid perRubricTightness";
      }
    }
    if (resp.note != null && typeof resp.note !== "string") return "invalid note";
    if (typeof resp.note === "string" && resp.note.length > MAX_NOTE) return "note too long";
  }
  return null;
}

// --- http helpers ------------------------------------------------------------

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
  });
  res.end(buf);
}

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.slice(1));
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(buf);
  });
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// --- server ------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (req.method === "GET" && pathname === "/api/tasks") {
    const d = data();
    sendJson(res, 200, {
      agent: d.agent,
      featured: d.featured.map((id) => d.byId[id]),
      poolIds: d.poolIds,
    });
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/task/")) {
    const id = decodeURIComponent(pathname.slice("/api/task/".length));
    const task = data().byId[id];
    if (!task) {
      sendJson(res, 404, { error: "unknown task" });
      return;
    }
    sendJson(res, 200, task);
    return;
  }

  if (req.method === "GET" && pathname === "/api/stats") {
    sendJson(res, 200, { submissions: countFeedback() });
    return;
  }

  if (req.method === "GET" && pathname === "/api/progress") {
    const name = (url.searchParams.get("name") || "").trim();
    const institution = (url.searchParams.get("institution") || "").trim();
    if (!name || !institution) {
      sendJson(res, 400, { error: "name and institution required" });
      return;
    }
    sendJson(res, 200, progressFor(name, institution));
    return;
  }

  if (req.method === "POST" && pathname === "/api/feedback") {
    try {
      const body = JSON.parse(await readBody(req));
      const validIds = new Set(Object.keys(data().byId));
      const err = validateSubmission(body, validIds);
      if (err) {
        sendJson(res, 400, { ok: false, error: err });
        return;
      }
      const record = {
        submittedAt: new Date().toISOString(),
        sessionId: typeof body.sessionId === "string" ? body.sessionId.slice(0, 64) : null,
        round: Number(body.round) || 1,
        respondent: {
          name: body.respondent.name.trim(),
          institution: body.respondent.institution.trim(),
        },
        responses: body.responses.map((r) => ({
          taskId: r.taskId,
          shownScore: r.shownScore ?? null,
          blindReaction: r.blindReaction,
          overallVerdict: r.overallVerdict,
          overallTightness: OVERALL_TIGHTNESS.has(r.overallTightness) ? r.overallTightness : null,
          perRubric: r.perRubric || {},
          perRubricTightness:
            r.perRubricTightness && typeof r.perRubricTightness === "object"
              ? r.perRubricTightness
              : {},
          note: typeof r.note === "string" ? r.note : "",
        })),
        meta: {
          userAgent: req.headers["user-agent"] || "",
          durationMs: Number(body?.meta?.durationMs) || null,
        },
      };
      await appendFeedback(record);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e.message || e) });
    }
    return;
  }

  if (req.method === "GET") {
    serveStatic(res, pathname);
    return;
  }

  res.writeHead(405, { "Content-Type": "text/plain" }).end("method not allowed");
});

server.listen(PORT, () => {
  const d = data();
  console.log(`expert-crowdsource on http://localhost:${PORT}`);
  console.log(`  agent: ${d.agent} | featured: ${d.featured.length} | pool: ${d.poolIds.length} (from ${d._source})`);
  console.log(`  feedback: ${FEEDBACK_FILE} (${countFeedback()} so far)`);
});
