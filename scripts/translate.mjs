// Offline pre-translation of judge reasoning into Simplified Chinese.
//
//   ANTHROPIC_API_KEY=sk-... node scripts/translate.mjs
//   node scripts/localize.mjs        # then merge into data/tasks.json
//
// Reads data/tasks.raw.json, translates each rubric's `reasoning` to Chinese,
// and writes data/translations.json keyed by "<taskId>::<rubricId>".
//
// Resumable: keys already present in translations.json are skipped, so an
// interrupted run can simply be re-run. Concurrency is capped to be gentle on
// rate limits.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, "..", "data");
const OUT = path.join(DATA, "translations.json");

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.TRANSLATE_MODEL || "claude-sonnet-4-6";
const CONCURRENCY = Number(process.env.TRANSLATE_CONCURRENCY) || 4;

if (!API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY environment variable.");
  process.exit(1);
}

const SYSTEM = `你是一名金融研究领域的专业翻译。请把以下"评分理由"从英文（或中英混杂）忠实翻译为简体中文。要求：
- 完整保留 Markdown 结构（标题、列表、表格、加粗、分隔线等）。
- 数字、百分比、股票代码、公司/机构名、专有名词、引用标注（如 [来源:...]）一律原样保留，不翻译、不改写。
- 已经是中文的部分保持原样。
- 只输出翻译后的正文，不要添加任何前言、说明或评论。`;

const raw = JSON.parse(fs.readFileSync(path.join(DATA, "tasks.raw.json"), "utf8"));
const store = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};

const jobs = [];
for (const t of raw.tasks) {
  for (const r of t.rubrics) {
    const key = `${t.taskId}::${r.rubricId}`;
    if (!r.reasoning || !r.reasoning.trim()) continue;
    if (store[key] && store[key].trim()) continue; // already done
    jobs.push({ key, text: r.reasoning });
  }
}

console.log(
  `${jobs.length} reasonings to translate (model=${MODEL}, concurrency=${CONCURRENCY})`,
);
if (jobs.length === 0) {
  console.log("Nothing to do. Run: node scripts/localize.mjs");
  process.exit(0);
}

async function translateOne(text) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      system: SYSTEM,
      messages: [{ role: "user", content: text }],
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.content || []).map((b) => b.text || "").join("");
}

function save() {
  fs.writeFileSync(OUT, JSON.stringify(store, null, 2));
}

let done = 0;
async function worker(queue) {
  while (queue.length) {
    const job = queue.shift();
    try {
      const zh = await translateOne(job.text);
      store[job.key] = zh;
      save(); // persist after each success → resumable
      done += 1;
      console.log(`  [${done}/${jobs.length}] ${job.key} ✓ (${zh.length} chars)`);
    } catch (e) {
      console.error(`  ${job.key} ✗ ${e.message}`);
    }
  }
}

const queue = [...jobs];
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker(queue)),
);

console.log(`Done. ${Object.keys(store).length} total translations in ${OUT}`);
console.log("Next: node scripts/localize.mjs");
