// Extract crowdsource tasks from the poc eval_pools.
//
//   node scripts/extract.mjs
//
// For every evaluated item in the source pool this:
//   - joins per-rubric scores with weights (checklist) and judge reasoning,
//   - reads the full report markdown,
//   - downloads remote report images to public/report-assets/<taskId>/ and
//     rewrites the markdown to local paths (the source URLs are signed/expiring),
//   - flags the curated "featured" set shown first.
//
// Emits:
//   data/tasks.raw.json            (all items; English reasoning, summaryZh empty)
//   data/reasonings/<taskId>.json  (per-item rubric reasoning, for the summarizer)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const POC = path.resolve(ROOT, "../poc");
const POOLS = path.join(POC, "eval_pools", "pools");
const DIM_DIR = path.join(POC, "rubrics", "_dimensions");
const ASSETS_DIR = path.join(ROOT, "public", "report-assets");
const REASON_DIR = path.join(ROOT, "data", "reasonings");

const POOL_ID = "pool_xxxxxxxxxxxx"; // source eval pool id
const EVAL_ID = "eval_xxxxxxxxxxxx"; // evaluation run id within that pool
const AGENT_LABEL = "Research Agent"; // shown to reviewers as the "answered by"

// Curated typical questions, shown first (high / mid / low score spread).
const FEATURED = ["q0001", "q0002", "q0003"];

const IMG_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|svg)$/i;
const EXT_BY_TYPE = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
};

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

// Copy a local deliverable image (a chart the agent drew) into the public assets
// dir and return its web path, so it can be rendered instead of dumped as bytes.
function copyLocalImage(taskId, srcPath, fileName) {
  const outDir = path.join(ASSETS_DIR, taskId);
  fs.mkdirSync(outDir, { recursive: true });
  let ext = path.extname(fileName || srcPath).toLowerCase();
  if (!ext) ext = ".png";
  const fname = `report${ext}`;
  fs.copyFileSync(srcPath, path.join(outDir, fname));
  return `/report-assets/${taskId}/${fname}`;
}

// Copy a non-renderable binary deliverable (xlsx, pdf, docx…) into the public
// assets dir, keeping its original name, and return a downloadable web path.
function copyLocalFile(taskId, srcPath, fileName) {
  const outDir = path.join(ASSETS_DIR, taskId);
  fs.mkdirSync(outDir, { recursive: true });
  const fname = (fileName || path.basename(srcPath)).replace(/[/\\]/g, "_");
  fs.copyFileSync(srcPath, path.join(outDir, fname));
  return `/report-assets/${taskId}/${encodeURIComponent(fname)}`;
}

function loadRubricNames() {
  const names = {};
  for (const f of fs.readdirSync(DIM_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const r = readJson(path.join(DIM_DIR, f));
      if (r.key) names[r.key] = r.name || r.key;
    } catch {
      /* skip */
    }
  }
  const zhPath = path.join(__dirname, "rubric-names.zh.json");
  if (fs.existsSync(zhPath)) Object.assign(names, readJson(zhPath));
  return names;
}

async function localizeImages(taskId, markdown) {
  const urls = [...markdown.matchAll(IMG_RE)].map((m) => m[2]);
  if (urls.length === 0) return { markdown, count: 0 };

  const outDir = path.join(ASSETS_DIR, taskId);
  fs.mkdirSync(outDir, { recursive: true });

  const urlToLocal = {};
  let idx = 0;
  for (const url of urls) {
    if (urlToLocal[url]) continue;
    const i = idx++;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = (res.headers.get("content-type") || "").split(";")[0].trim();
      const ext = EXT_BY_TYPE[type] || ".png";
      const buf = Buffer.from(await res.arrayBuffer());
      const fname = `img-${i}${ext}`;
      fs.writeFileSync(path.join(outDir, fname), buf);
      urlToLocal[url] = `/report-assets/${taskId}/${fname}`;
    } catch (e) {
      console.warn(`    ! image ${i} failed (${e.message}) — keeping source URL`);
      urlToLocal[url] = url; // leave as-is on failure
    }
  }

  const rewritten = markdown.replace(IMG_RE, (full, alt, url) => {
    const local = urlToLocal[url] || url;
    return `![${alt}](${local})`;
  });
  return { markdown: rewritten, count: Object.values(urlToLocal).filter((v) => v.startsWith("/")).length };
}

async function main() {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  fs.mkdirSync(REASON_DIR, { recursive: true });

  const rubricNames = loadRubricNames();
  const pool = readJson(path.join(POOLS, POOL_ID, "pool.json"));
  const itemById = Object.fromEntries(pool.items.map((it) => [it.id, it]));

  const records = fs
    .readFileSync(path.join(POOLS, POOL_ID, "evaluations", EVAL_ID, "results.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const tasks = [];
  for (const rec of records) {
    const item = itemById[rec.task?.task_id];
    if (!item) continue;
    const taskId = item.benchmarkTaskId;

    const weightByRubric = {};
    for (const unit of rec.checklist || []) {
      for (const ru of unit.rubrics || []) weightByRubric[ru.rubric_id] = ru.weight;
    }

    const rubrics = (rec.scores?.per_rubric || []).map((pr) => {
      const vote = pr.per_judge_votes?.[0] || {};
      return {
        rubricId: pr.rubric_id,
        name: rubricNames[pr.rubric_id] || pr.rubric_id,
        value: pr.aggregated_value,
        verdict: pr.aggregated_verdict ?? null,
        weight: weightByRubric[pr.rubric_id] ?? null,
        kind: pr.kind ?? null,
        judgeId: vote.judge_id ?? null,
        reasoning: vote.reasoning ?? "",
        summaryZh: "", // filled by summarize/localize
      };
    });

    // Report: classify the deliverable by type and render accordingly. NEVER
    // read a binary file as text (that produced mojibake for .png / .xlsx).
    //   image (.png…)  -> copy in, render as <img>
    //   html (.html)   -> keep raw, render in a sandboxed iframe
    //   text (.md/.txt)-> markdown, localize embedded images
    //   other (.xlsx…) -> downloadable attachment, fall back to the answer text
    const reportFile = (item.outputFiles || [])[0] || null;
    let report = "";
    let reportFileName = null;
    let reportKind = "markdown";
    let attachmentPath = null;
    let imgCount = 0;
    if (reportFile?.localPath && fs.existsSync(reportFile.localPath)) {
      reportFileName = reportFile.fileName || null;
      const name = reportFile.fileName || reportFile.localPath;
      if (IMG_EXT_RE.test(name)) {
        const local = copyLocalImage(taskId, reportFile.localPath, reportFile.fileName);
        report = `![${reportFileName || "report"}](${local})`;
        reportKind = "image";
        imgCount = 1;
      } else if (/\.html?$/i.test(name)) {
        report = fs.readFileSync(reportFile.localPath, "utf8");
        reportKind = "html";
      } else if (/\.(md|markdown|txt)$/i.test(name) || !path.extname(name)) {
        const md = fs.readFileSync(reportFile.localPath, "utf8");
        const r = await localizeImages(taskId, md);
        report = r.markdown;
        reportKind = "markdown";
        imgCount = r.count;
      } else {
        attachmentPath = copyLocalFile(taskId, reportFile.localPath, reportFile.fileName);
        reportKind = "attachment";
      }
    }

    const task = {
      taskId,
      featured: FEATURED.includes(taskId),
      agent: AGENT_LABEL,
      question: item.question,
      answer: item.answer || "", // fallback when no report markdown
      reportFileName,
      reportKind,
      attachmentPath,
      report,
      overall: {
        score: rec.scores?.overall?.score ?? null,
        grade: rec.scores?.overall?.grade ?? null,
      },
      rubrics,
    };
    tasks.push(task);

    // Per-item reasoning file for the summarizer (small, no report).
    fs.writeFileSync(
      path.join(REASON_DIR, `${taskId}.json`),
      JSON.stringify(
        {
          taskId,
          question: item.question,
          rubrics: rubrics.map((r) => ({
            rubricId: r.rubricId,
            name: r.name,
            value: r.value,
            weight: r.weight,
            reasoning: r.reasoning,
          })),
        },
        null,
        2,
      ),
    );

    console.log(
      `  ${taskId}${task.featured ? " ★" : "  "} score=${task.overall.score?.toFixed(3)} ${task.overall.grade} | ${rubrics.length} rubrics | report ${report.length}c, ${imgCount} imgs`,
    );
  }

  // Featured first, then the rest in score order (low -> high) for the random pool.
  tasks.sort((a, b) => {
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    return (a.overall.score ?? 0) - (b.overall.score ?? 0);
  });

  const out = { generatedFrom: { poolId: POOL_ID, evalId: EVAL_ID }, agent: AGENT_LABEL, tasks };
  fs.writeFileSync(path.join(ROOT, "data", "tasks.raw.json"), JSON.stringify(out, null, 2));
  console.log(
    `\nWrote data/tasks.raw.json — ${tasks.length} tasks (${tasks.filter((t) => t.featured).length} featured), ${tasks.reduce((n, t) => n + t.rubrics.length, 0)} rubric reasonings`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
