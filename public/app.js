// Expert crowdsource flow:
//   identity -> round of tasks (blind score -> informed rubric review) -> submit
//   -> offer another round of 2 random pool questions -> ... -> done.
// Vanilla JS, single mutable state object re-rendered on change.

const TITLE = "投研 Agent 评测框架 · 专家评议";
const EXTRA_PER_ROUND = 2;

const BLIND_CHOICES = [
  { key: "too_low", label: "偏低" },
  { key: "reasonable", label: "合理" },
  { key: "too_high", label: "偏高" },
];

// When a score is judged "不合理", we ask which way it is off. The third option
// differs by level: a single rubric can be "没必要评" (needn't be scored), while
// the overall set can have "维度有问题" (the wrong dimensions were evaluated).
const TIGHTNESS_BASE = [
  { key: "too_strict", label: "评分过紧", hint: "应更高" },
  { key: "too_lenient", label: "评分过松", hint: "应更低" },
];
const RUBRIC_TIGHTNESS_CHOICES = [
  ...TIGHTNESS_BASE,
  { key: "unnecessary", label: "没必要评", hint: "该项可不计分" },
];
const OVERALL_TIGHTNESS_CHOICES = [
  ...TIGHTNESS_BASE,
  { key: "wrong_dimensions", label: "维度有问题", hint: "评错/漏评了维度" },
];

const state = {
  phase: "welcome", // welcome | task | round-done | done
  agent: "",
  featured: [],
  poolIds: [],
  respondent: { name: "", institution: "" },
  sessionId: null,
  round: 1,
  queue: [], // full task objects for the current round
  taskIndex: 0,
  responses: {}, // taskId -> { blindReaction, revealed, overallVerdict, perRubric, note }
  seen: new Set(), // taskIds already presented
  expandedReport: false,
  openReason: {}, // `${taskId}:${rubricId}` -> show full reasoning
  startedAt: Date.now(),
  submitting: false,
  loading: false,
  error: "",
};

const app = document.getElementById("app");

// ---------- helpers ----------

const pct = (v) => (v == null || Number.isNaN(v) ? 0 : Math.round(v * 100));

function gradeColor(grade) {
  const g = (grade || "").trim().toUpperCase()[0];
  if (g === "A" || g === "B") return "var(--color-good)";
  if (g === "C" || g === "D") return "var(--color-warn)";
  return "var(--color-bad)";
}
function barColor(v) {
  if (v >= 0.7) return "var(--color-good)";
  if (v >= 0.4) return "var(--color-warn)";
  return "var(--color-bad)";
}
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// For values placed inside a double-quoted HTML attribute (e.g. iframe srcdoc).
function escAttr(s) {
  return esc(s).replace(/"/g, "&quot;");
}
// Inline citation markers in reports look like:
//   [来源:类型|来源方|标题]   (来源方 may be empty; 标题 may itself contain '|')
// They are visually noisy when left inline, so before markdown rendering we turn
// each into a small superscript footnote, de-duplicated by source, and collect a
// "参考来源" list appended after the report. Source info stays traceable (it
// matters for the source_authority rubric) without cluttering the prose.
const SOURCE_RE = /\[来源:([^\]]*)\]/g;
const SOURCE_TYPE_LABEL = {
  web: "网页",
  report: "研报",
  comment: "点评",
  roadshow: "电话会",
  social_media: "社媒",
  edb: "数据库",
  foreign_report: "海外研报",
  announcement: "公告",
};

function parseCitations(text) {
  const refs = [];
  const byKey = new Map();
  const stripped = String(text || "").replace(SOURCE_RE, (_, body) => {
    const parts = String(body).split("|");
    const type = (parts[0] || "").trim();
    const source = (parts[1] || "").trim();
    const title = parts.slice(2).join("|").trim();
    const key = `${type}|${source}|${title}`;
    let ref = byKey.get(key);
    if (!ref) {
      ref = { n: refs.length + 1, type, source, title };
      byKey.set(key, ref);
      refs.push(ref);
    }
    // The marker may sit inside a markdown table cell; a raw '|' in the title
    // attribute would split the table columns, so neutralize it in the tooltip.
    const tip = [ref.source, ref.title].filter(Boolean).join(" · ").replace(/\|/g, "／");
    return `<sup class="cite" title="${esc(tip)}">${ref.n}</sup>`;
  });
  return { stripped, refs };
}

function citationsListHtml(refs) {
  if (!refs.length) return "";
  const items = refs
    .map((r) => {
      const label = SOURCE_TYPE_LABEL[r.type] || r.type || "来源";
      const src = r.source ? `${esc(r.source)}` : "";
      const title = r.title ? `《${esc(r.title)}》` : "";
      const sep = src && title ? " " : "";
      return `<li><span class="cite-ref__n">${r.n}</span>
        <span class="cite-ref__txt">${src}${sep}${title}</span>
        <span class="cite-ref__tag">${esc(label)}</span></li>`;
    })
    .join("");
  return `
  <details class="cite-list">
    <summary>参考来源 · ${refs.length} 条</summary>
    <ol class="cite-ref">${items}</ol>
  </details>`;
}

function renderMd(text) {
  const { stripped, refs } = parseCitations(text);
  let html;
  try {
    html = window.marked.parse(stripped, { breaks: false, gfm: true });
  } catch {
    html = `<p>${esc(stripped)}</p>`;
  }
  return html + citationsListHtml(refs);
}
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "s-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Remember who this is, so the name/institution are pre-filled on return and we
// can ask the server what they have already evaluated.
const LS_KEY = "crowd.respondent";
function saveRespondent() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state.respondent));
  } catch {
    /* private mode / disabled storage — non-fatal */
  }
}
function loadRespondent() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (o && o.name) state.respondent = { name: o.name || "", institution: o.institution || "" };
  } catch {
    /* ignore */
  }
}

function ensureResponse(taskId) {
  if (!state.responses[taskId]) {
    state.responses[taskId] = {
      blindReaction: null,
      revealed: false,
      overallVerdict: null,
      overallTightness: null, // when overallVerdict==="unreasonable": too_strict|too_lenient
      perRubric: {}, // rubricId -> "reasonable"|"unreasonable"
      perRubricTightness: {}, // rubricId -> "too_strict"|"too_lenient" (when unreasonable)
      note: "",
    };
  }
  return state.responses[taskId];
}
const currentTask = () => state.queue[state.taskIndex];

// ---------- root render ----------

function render() {
  if (state.phase === "welcome") app.innerHTML = viewWelcome();
  else if (state.phase === "welcome-back") app.innerHTML = viewWelcomeBack();
  else if (state.phase === "done") app.innerHTML = viewDone();
  else if (state.phase === "round-done") app.innerHTML = viewRoundDone();
  else app.innerHTML = viewTask();
  bind();
}

function brandbar(meta = "") {
  return `
  <div class="brandbar">
    <span class="brandbar__dot"></span>
    <span class="brandbar__title">${esc(TITLE)}</span>
    <span class="brandbar__spacer"></span>
    ${meta ? `<span class="brandbar__meta">${esc(meta)}</span>` : ""}
  </div>`;
}

// ---------- welcome ----------

function viewWelcome() {
  const n = esc(state.respondent.name);
  const inst = esc(state.respondent.institution);
  return `
  ${brandbar()}
  <section class="welcome">
    <p class="welcome__eyebrow">Expert Review · 专家评议</p>
    <h1>投研 Agent 的回答,评得准吗?</h1>
    <p class="welcome__lead">
      下面是 ${esc(state.agent || "投研 Agent")} 对若干真实研究问题给出的报告,以及自动评测系统给出的分数。
      想请您以行业专家的视角,判断这些评分是否合理。
    </p>
    <ol class="welcome__steps">
      <li><b>1</b><span>阅读问题与 Agent 输出的完整报告</span></li>
      <li><b>2</b><span>先看总分,凭直觉判断它<strong>偏低 / 合理 / 偏高</strong></span></li>
      <li><b>3</b><span>再看逐项评分依据,判断评分是否合理,并留下您的意见</span></li>
    </ol>
    <div class="card">
      <form class="form" id="welcome-form">
        <div class="field">
          <label for="f-name">您的姓名</label>
          <input id="f-name" name="name" autocomplete="name" value="${n}" placeholder="如:张三" required />
        </div>
        <div class="field">
          <label for="f-inst">所在机构</label>
          <input id="f-inst" name="institution" autocomplete="organization" value="${inst}" placeholder="如:XX 证券研究所 / XX 资管" required />
        </div>
        ${state.error ? `<p class="form__err">${esc(state.error)}</p>` : ""}
        <button type="submit" class="btn btn--primary btn--block" id="start-btn" ${state.loading ? "disabled" : ""}>${state.loading ? "检查中…" : "开始评议 →"}</button>
      </form>
    </div>
  </section>`;
}

// ---------- task ----------

function viewTask() {
  const task = currentTask();
  const r = ensureResponse(task.taskId);
  const total = state.queue.length;
  const idx = state.taskIndex;

  const pips = state.queue
    .map((_, i) => {
      const cls = i < idx ? "steps__pip--done" : i === idx ? "steps__pip--active" : "";
      return `<div class="steps__pip ${cls}"></div>`;
    })
    .join("");

  const roundLabel = state.round === 1 ? "" : `第 ${state.round} 轮 · `;

  return `
  ${brandbar(`${roundLabel}${idx + 1} / ${total}`)}
  <div class="shell">
    <div class="steps">${pips}</div>

    <p class="task__counter">问题 ${idx + 1}${task.featured ? "" : " · 随机抽取"}</p>
    <h2 class="task__question">${esc(task.question)}</h2>
    <p class="task__agent">作答:<b>${esc(task.agent)}</b></p>

    <div class="section-label">Agent 输出的完整报告</div>
    ${reportBlock(task)}

    <div class="section-label">第一步 · 凭直觉评判总分</div>
    ${stageA(task, r)}

    ${r.revealed ? stageB(task, r) : lockedHint()}
  </div>`;
}

function reportBlock(task) {
  const kind = task.reportKind || "markdown";

  // Binary deliverable (xlsx, pdf…): can't preview inline — offer a download
  // and show the answer summary instead.
  if (kind === "attachment") {
    return `
    <div class="report">
      <div class="report__head">
        <span class="report__file">${esc(task.reportFileName || "交付文件")}</span>
        <span>附件</span>
      </div>
      <div class="report__attach">
        <a class="report__download" href="${esc(task.attachmentPath)}" download>⬇ 下载原始交付物:${esc(task.reportFileName || "文件")}</a>
        <p class="report__attach-note">该交付物为文件,无法内联预览。以下为作答摘要:</p>
        <div class="md report__md">${renderMd(task.answer || "")}</div>
      </div>
    </div>`;
  }

  // Self-contained HTML page (interactive chart): render in a sandboxed iframe
  // so its scripts run isolated from the host page.
  if (kind === "html") {
    return `
    <div class="report">
      <div class="report__head">
        <span class="report__file">${esc(task.reportFileName || "网页报告")}</span>
        <span>交互网页</span>
      </div>
      <iframe class="report__iframe" sandbox="allow-scripts allow-popups"
        referrerpolicy="no-referrer" loading="lazy"
        srcdoc="${escAttr(task.report || "")}" title="${esc(task.reportFileName || "报告")}"></iframe>
      <p class="report__iframe-note">↑ Agent 生成的交互式网页,在隔离沙箱中渲染</p>
    </div>`;
  }

  // markdown or image
  const expanded = state.expandedReport;
  const hasReport = !!(task.report && task.report.trim());
  const body = hasReport ? task.report : task.answer;
  const isImageReport =
    kind === "image" || /\.(png|jpe?g|gif|webp|svg)$/i.test(task.reportFileName || "");
  const sizeTxt = !hasReport
    ? "摘要"
    : isImageReport
      ? "图表"
      : `${Math.round(task.report.length / 1000)}k 字`;
  return `
  <div class="report">
    <div class="report__head">
      <span class="report__file">${esc(task.reportFileName || (hasReport ? "报告" : "回答摘要"))}</span>
      <span>${sizeTxt}</span>
    </div>
    <div class="report__body ${expanded ? "is-expanded" : ""}">
      <div class="md report__md">${renderMd(body)}</div>
    </div>
    <button class="report__toggle" data-act="toggle-report">
      ${expanded ? "收起报告 ▲" : "展开全文 ▼"}
    </button>
  </div>`;
}

function stageA(task, r) {
  const score = pct(task.overall.score);
  const grade = task.overall.grade || "—";
  const gc = gradeColor(grade);
  const choices = BLIND_CHOICES.map(
    (c) => `
    <button class="choice" data-act="blind" data-val="${c.key}"
      aria-pressed="${r.blindReaction === c.key}">${c.label}</button>`,
  ).join("");

  return `
  <div class="card">
    <div class="scorecard">
      <div class="scoredial" style="--val:${score};--dial-color:${gc}">
        <div class="scoredial__inner">
          <div class="scoredial__num">${score}</div>
          <div class="scoredial__den">/ 100</div>
          <div class="scoredial__grade" style="background:${gc}">${esc(grade)}</div>
        </div>
      </div>
      <div class="scoreask">
        <p class="scoreask__q">系统给这份报告打了 ${score} 分,您觉得?</p>
        <p class="scoreask__hint">先别看评分依据 —— 凭您的专业直觉。</p>
        <div class="choices">${choices}</div>
        ${
          r.blindReaction && !r.revealed
            ? `<div class="scoreask__cta"><button class="btn btn--primary" data-act="reveal">查看评分依据 →</button></div>`
            : ""
        }
      </div>
    </div>
  </div>`;
}

const lockedHint = () =>
  `<p class="locked-hint">↑ 选择您的直觉判断后,即可查看逐项评分依据</p>`;

function stageB(task, r) {
  const rubrics = task.rubrics.map((ru) => rubricCard(task, ru, r)).join("");
  const isLastTask = state.taskIndex === state.queue.length - 1;
  const canProceed = !!r.overallVerdict;

  return `
  <div class="reveal">
    <div class="section-label">第二步 · 评分依据是否合理</div>
    <p class="rubrics__disclaimer">
      下列评分理由为对评审(judge)推理的 <b>AI 摘要</b>,并非原始评审内容;
      如需核对,可点开每项的「展开 judge 完整推理」查看原文。
    </p>
    <div class="rubrics">${rubrics}</div>

    <div class="card overall-verdict">
      <h3>总体来看,这套评分合理吗?</h3>
      <p>综合上面各项的打分与依据,给一个整体判断(必选)。</p>
      <div class="choices choices--tight">
        <button class="choice" data-act="overall" data-val="reasonable"
          aria-pressed="${r.overallVerdict === "reasonable"}">合理</button>
        <button class="choice" data-act="overall" data-val="unreasonable"
          aria-pressed="${r.overallVerdict === "unreasonable"}">不合理</button>
      </div>
      ${
        r.overallVerdict === "unreasonable"
          ? tightnessRow("overall-tight", r.overallTightness, OVERALL_TIGHTNESS_CHOICES)
          : ""
      }
      <div class="note">
        <label for="note">补充意见(选填):哪里评得不对?该多少分?还该补评哪些维度?</label>
        <textarea id="note" data-act="note" placeholder="例如:数据质量这项判得过严,报告其实有券商研报支撑;另外建议增加一个『风险揭示充分性』维度……">${esc(r.note)}</textarea>
      </div>
    </div>

    ${state.error ? `<p class="form__err form__err--center">${esc(state.error)}</p>` : ""}

    <div class="task__nav">
      ${state.taskIndex > 0 ? `<button class="btn btn--ghost" data-act="prev">← 上一题</button>` : `<span></span>`}
      <button class="btn btn--primary" data-act="next" ${canProceed && !state.submitting ? "" : "disabled"}>
        ${state.submitting ? "提交中…" : isLastTask ? "提交本轮 ✓" : "下一题 →"}
      </button>
    </div>
  </div>`;
}

function rubricCard(task, ru, r) {
  const v = ru.value ?? 0;
  const key = `${task.taskId}:${ru.rubricId}`;
  const showFull = !!state.openReason[key];
  const verdict = r.perRubric[ru.rubricId] || null;
  const weightTxt = ru.weight != null ? `权重 ${ru.weight}` : "";
  const summary = ru.summary && ru.summary.trim();
  const hasFull = !!(ru.reasoning && ru.reasoning.trim());

  return `
  <div class="rubric">
    <div class="rubric__head">
      <div>
        <span class="rubric__name">${esc(ru.name)}</span>
        <span class="rubric__weight">${weightTxt}</span>
      </div>
      <div class="rubric__val" style="color:${barColor(v)}">${pct(v)}<span class="rubric__pctsign">%</span></div>
      <div class="rubric__bar"><i style="width:${pct(v)}%;--bar-color:${barColor(v)}"></i></div>
    </div>

    <div class="rubric__summary">
      ${summary ? esc(ru.summary) : `<span class="rubric__pending">评分理由摘要生成中…</span>`}
    </div>

    ${
      hasFull
        ? `<button class="rubric__fulltoggle" data-act="reason" data-key="${key}">${showFull ? "收起完整推理 ▲" : "展开 judge 完整推理"}</button>
           ${showFull ? `<div class="rubric__reason md">${renderMd(ru.reasoning)}</div>` : ""}`
        : ""
    }

    <div class="rubric__verdict">
      <span>这一项评得?</span>
      <button class="pill pill--good" data-act="rubric-verdict" data-rid="${ru.rubricId}" data-val="reasonable"
        aria-pressed="${verdict === "reasonable"}">合理</button>
      <button class="pill pill--bad" data-act="rubric-verdict" data-rid="${ru.rubricId}" data-val="unreasonable"
        aria-pressed="${verdict === "unreasonable"}">不合理</button>
    </div>
    ${
      verdict === "unreasonable"
        ? tightnessRow(
            "rubric-tight",
            r.perRubricTightness[ru.rubricId],
            RUBRIC_TIGHTNESS_CHOICES,
            `data-rid="${ru.rubricId}"`,
          )
        : ""
    }
  </div>`;
}

// Follow-up shown after a "不合理" verdict; `choices` differs by level.
function tightnessRow(act, current, choices, extraAttr = "") {
  const opts = choices
    .map(
      (c) => `
    <button class="tight-pill" data-act="${act}" data-val="${c.key}" ${extraAttr}
      aria-pressed="${current === c.key}">${c.label}<small>${c.hint}</small></button>`,
    )
    .join("");
  return `<div class="tightness"><span>偏向</span>${opts}</div>`;
}

// ---------- round done (offer more) ----------

function viewRoundDone() {
  const remaining = unseenPoolIds().length;
  const totalDone = state.seen.size;
  const canMore = remaining > 0;
  return `
  ${brandbar()}
  <section class="done">
    <div class="done__mark">✓</div>
    <h1>本轮已提交,感谢!</h1>
    <p>您已评议 <b>${totalDone}</b> 题。${canMore ? `还想再帮我们看 ${Math.min(EXTRA_PER_ROUND, remaining)} 题吗?将从题库中随机抽取。` : "题库里的题目您已全部评议完毕。"}</p>
    ${state.error ? `<p class="form__err form__err--center">${esc(state.error)}</p>` : ""}
    <div class="done__actions">
      ${
        canMore
          ? `<button class="btn btn--primary" data-act="more" ${state.loading ? "disabled" : ""}>${state.loading ? "抽取中…" : `再来 ${Math.min(EXTRA_PER_ROUND, remaining)} 题 →`}</button>`
          : ""
      }
      <button class="btn btn--ghost" data-act="finish">结束评议</button>
    </div>
  </section>`;
}

// ---------- welcome back (returning expert) ----------

function viewWelcomeBack() {
  const remaining = unseenPoolIds().length;
  const done = state.seen.size;
  const canMore = remaining > 0;
  return `
  ${brandbar()}
  <section class="done">
    <div class="done__mark done__mark--wave">👋</div>
    <h1>欢迎回来,${esc(state.respondent.name)}</h1>
    <p>您此前已评议 <b>${done}</b> 题,无需重复作答。${
      canMore
        ? `如果有时间,欢迎再帮我们看 ${Math.min(EXTRA_PER_ROUND, remaining)} 题(从题库随机抽取)。`
        : "题库里的题目您已全部评议完毕,非常感谢!"
    }</p>
    ${state.error ? `<p class="form__err form__err--center">${esc(state.error)}</p>` : ""}
    <div class="done__actions">
      ${
        canMore
          ? `<button class="btn btn--primary" data-act="more" ${state.loading ? "disabled" : ""}>${state.loading ? "抽取中…" : `再来 ${Math.min(EXTRA_PER_ROUND, remaining)} 题 →`}</button>`
          : ""
      }
      <button class="btn btn--ghost" data-act="finish">结束评议</button>
    </div>
  </section>`;
}

// ---------- done ----------

function viewDone() {
  return `
  ${brandbar()}
  <section class="done">
    <div class="done__mark">✓</div>
    <h1>感谢您的评议</h1>
    <p>您共评议了 <b>${state.seen.size}</b> 题。您的专业意见已记录,这对校准我们的评测体系非常有帮助。</p>
  </section>`;
}

// ---------- events ----------

function bind() {
  const form = document.getElementById("welcome-form");
  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const name = (fd.get("name") || "").toString().trim();
      const institution = (fd.get("institution") || "").toString().trim();
      if (!name || !institution) {
        state.error = "请填写姓名和机构";
        return render();
      }
      beginForRespondent(name, institution);
    });
  }

  app.querySelectorAll("[data-act]").forEach((el) => {
    const act = el.getAttribute("data-act");
    if (act === "note") {
      el.addEventListener("input", (e) => {
        ensureResponse(currentTask().taskId).note = e.target.value;
      });
      return;
    }
    el.addEventListener("click", () => handleAction(act, el));
  });
}

function handleAction(act, el) {
  if (act === "more") return startExtraRound();
  if (act === "finish") {
    state.phase = "done";
    return render();
  }

  const task = currentTask();
  const r = ensureResponse(task.taskId);
  switch (act) {
    case "toggle-report":
      state.expandedReport = !state.expandedReport;
      return render();
    case "blind":
      r.blindReaction = el.getAttribute("data-val");
      return render();
    case "reveal":
      r.revealed = true;
      return render();
    case "reason": {
      const key = el.getAttribute("data-key");
      state.openReason[key] = !state.openReason[key];
      return render();
    }
    case "rubric-verdict": {
      const rid = el.getAttribute("data-rid");
      const val = el.getAttribute("data-val");
      r.perRubric[rid] = r.perRubric[rid] === val ? null : val;
      if (r.perRubric[rid] !== "unreasonable") delete r.perRubricTightness[rid];
      return render();
    }
    case "rubric-tight": {
      const rid = el.getAttribute("data-rid");
      const val = el.getAttribute("data-val");
      r.perRubricTightness[rid] = r.perRubricTightness[rid] === val ? null : val;
      return render();
    }
    case "overall":
      r.overallVerdict = el.getAttribute("data-val");
      if (r.overallVerdict !== "unreasonable") r.overallTightness = null;
      state.error = "";
      return render();
    case "overall-tight":
      r.overallTightness = r.overallTightness === el.getAttribute("data-val") ? null : el.getAttribute("data-val");
      return render();
    case "prev":
      state.taskIndex = Math.max(0, state.taskIndex - 1);
      state.expandedReport = false;
      return render();
    case "next":
      return goNext();
  }
}

// ---------- round / flow control ----------

// Entry point after the identity form: remember the respondent, ask the server
// what they've already done, and either resume (returning expert) or start the
// featured round (new expert).
async function beginForRespondent(name, institution) {
  state.respondent = { name, institution };
  saveRespondent();
  state.error = "";
  state.loading = true;
  render();

  let prog = { seen: [], submissions: 0, lastSessionId: null, maxRound: 0 };
  try {
    const res = await fetch(
      `/api/progress?name=${encodeURIComponent(name)}&institution=${encodeURIComponent(institution)}`,
    );
    if (res.ok) prog = await res.json();
  } catch {
    /* treat as a new respondent if the lookup fails */
  }
  state.loading = false;

  state.seen = new Set(prog.seen || []);
  state.sessionId = prog.lastSessionId || uuid();

  const featuredIds = state.featured.map((t) => t.taskId);
  const doneFeatured =
    featuredIds.length > 0 && featuredIds.every((id) => state.seen.has(id));

  if (prog.submissions > 0 && doneFeatured) {
    // Returning expert who already finished the featured round — don't repeat it.
    state.round = prog.maxRound || 1;
    state.phase = "welcome-back";
    return render();
  }
  // New expert (or hasn't finished the featured set) — run the featured round.
  startRound(state.featured, 1);
}

function startRound(tasks, round) {
  state.queue = tasks;
  state.round = round;
  state.taskIndex = 0;
  state.expandedReport = false;
  state.error = "";
  state.phase = "task";
  state.startedAt = Date.now();
  for (const t of tasks) state.seen.add(t.taskId);
  render();
}

function unseenPoolIds() {
  return state.poolIds.filter((id) => !state.seen.has(id));
}

function pickRandom(arr, n) {
  const copy = [...arr];
  const out = [];
  while (out.length < n && copy.length) {
    const i = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}

async function startExtraRound() {
  const ids = pickRandom(unseenPoolIds(), EXTRA_PER_ROUND);
  if (!ids.length) {
    state.phase = "done";
    return render();
  }
  state.loading = true;
  state.error = "";
  render();
  try {
    const tasks = await Promise.all(
      ids.map((id) => fetch(`/api/task/${encodeURIComponent(id)}`).then((res) => {
        if (!res.ok) throw new Error(`加载 ${id} 失败`);
        return res.json();
      })),
    );
    state.loading = false;
    startRound(tasks, state.round + 1);
  } catch (e) {
    state.loading = false;
    state.error = `抽题失败:${e.message}。请重试。`;
    render();
  }
}

function goNext() {
  const r = ensureResponse(currentTask().taskId);
  if (!r.overallVerdict) {
    state.error = "请先给出总体判断";
    return render();
  }
  if (state.taskIndex < state.queue.length - 1) {
    state.taskIndex += 1;
    state.expandedReport = false;
    state.error = "";
    return render();
  }
  submitRound();
}

async function submitRound() {
  state.submitting = true;
  state.error = "";
  render();

  const payload = {
    sessionId: state.sessionId,
    round: state.round,
    respondent: state.respondent,
    responses: state.queue.map((t) => {
      const r = ensureResponse(t.taskId);
      const perRubric = {};
      for (const [k, v] of Object.entries(r.perRubric)) if (v) perRubric[k] = v;
      const perRubricTightness = {};
      for (const [k, v] of Object.entries(r.perRubricTightness)) {
        if (v && perRubric[k] === "unreasonable") perRubricTightness[k] = v;
      }
      return {
        taskId: t.taskId,
        shownScore: t.overall.score,
        blindReaction: r.blindReaction,
        overallVerdict: r.overallVerdict,
        overallTightness: r.overallVerdict === "unreasonable" ? r.overallTightness : null,
        perRubric,
        perRubricTightness,
        note: r.note || "",
      };
    }),
    meta: { durationMs: Date.now() - state.startedAt },
  };

  try {
    const res = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const out = await res.json();
    if (!res.ok || !out.ok) throw new Error(out.error || "提交失败");
    state.phase = "round-done";
  } catch (e) {
    state.error = `提交失败:${e.message}。请重试。`;
  } finally {
    state.submitting = false;
    render();
  }
}

// ---------- boot ----------

async function boot() {
  loadRespondent(); // pre-fill name/institution for returning experts
  try {
    const res = await fetch("/api/tasks");
    const d = await res.json();
    state.agent = d.agent || "";
    state.featured = d.featured || [];
    state.poolIds = d.poolIds || [];
  } catch (e) {
    app.innerHTML = `<div class="shell"><p class="form__err">加载题目失败:${esc(e.message)}</p></div>`;
    return;
  }
  render();
}

boot();
