// Merge Chinese rubric summaries into the final data/tasks.json.
//
//   node scripts/localize.mjs
//
// Reads:
//   data/tasks.raw.json        (from extract.mjs; English judge reasoning)
//   data/summaries.json        (map "<taskId>::<rubricId>" -> 2-3 句中文摘要)
// Writes:
//   data/tasks.json            (summaryZh filled where a summary exists)
//
// Missing summaries leave summaryZh = "" so the app falls back to "摘要生成中…"
// while keeping the full reasoning available — supports incremental rollout.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, "..", "data");

const raw = JSON.parse(fs.readFileSync(path.join(DATA, "tasks.raw.json"), "utf8"));
const sumPath = path.join(DATA, "summaries.json");
const summaries = fs.existsSync(sumPath)
  ? JSON.parse(fs.readFileSync(sumPath, "utf8"))
  : {};

let filled = 0;
let missing = 0;
const tasks = raw.tasks.map((t) => ({
  ...t,
  rubrics: t.rubrics.map((r) => {
    const zh = summaries[`${t.taskId}::${r.rubricId}`];
    if (zh && zh.trim()) {
      filled += 1;
      return { ...r, summaryZh: zh };
    }
    missing += 1;
    return { ...r, summaryZh: "" };
  }),
}));

fs.writeFileSync(path.join(DATA, "tasks.json"), JSON.stringify({ ...raw, tasks }, null, 2));
console.log(`Wrote data/tasks.json — ${filled} summaries, ${missing} pending`);
