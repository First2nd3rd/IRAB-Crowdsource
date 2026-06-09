# Expert Crowdsource · 专家评议平台

对投研 Agent 的回答与自动评分进行专家评议。专家阅读「问题 + Agent 完整报告」,
先凭直觉判断总分偏高/偏低/合理(盲评),再查看逐项评分依据(每条 rubric 直接给出
2-3 句中文摘要,说明 judge 为何这么打分)判断是否合理,最后留下意见。答完 3 道
典型题后,可选择「再来 2 题」从题库中随机抽取继续评议。所有反馈记录到
`data/feedback.jsonl`。

零外部依赖(Node 内置 http),`node server.js` 即可运行,便于直接部署到 VPS。

## 目录

```
expertCrowdsource/
├── server.js                    # 零依赖 http 服务
├── package.json
├── scripts/
│   ├── extract.mjs              # 从 ../poc/eval_pools 抽全部已评测题 → tasks.raw.json
│   │                           #   + 下载报告图片到 public/report-assets 并改写 md
│   │                           #   + 每题 reasoning 落到 data/reasonings/<taskId>.json
│   ├── rubric-names.zh.json     # rubric 中文名映射(可编辑)
│   ├── summarize.workflow.js    # 多 agent 并行,为每条 rubric 生成中文摘要(主路径)
│   ├── translate.mjs            # 备选:调 Anthropic API 翻译(需 API key)
│   └── localize.mjs             # 合并 summaries.json → data/tasks.json
├── data/
│   ├── tasks.raw.json           # 抽取产物(英文 reasoning,summaryZh 空)
│   ├── reasonings/<taskId>.json # 每题 rubric reasoning(供摘要 agent 读取)
│   ├── summaries.json           # 摘要产物(键 "<taskId>::<rubricId>")
│   ├── tasks.json               # 最终配置(前端读这个;不存在则回退 tasks.raw.json)
│   └── feedback.jsonl           # 收集到的专家反馈(每行一份提交)
└── public/
    ├── index.html / app.js / styles.css
    ├── vendor/marked.min.js     # 自托管 markdown 渲染
    └── report-assets/<taskId>/  # 本地化后的报告图片
```

## 数据流水线

```bash
# 1. 抽取题目 + 下载报告图片(题目范围在 extract.mjs 的 POOL_ID/EVAL_ID/FEATURED)
npm run extract

# 2. 生成中文摘要 —— 用 Claude Code 的 Workflow 跑 scripts/summarize.workflow.js
#    (每题一个子 agent 并行,各读 data/reasonings/<taskId>.json,产出每条 rubric 的摘要)
#    把工作流返回的结果写成 data/summaries.json,键为 "<taskId>::<rubricId>"。
#    备选:ANTHROPIC_API_KEY=sk-... npm run translate  (改写为生成 summaries.json)

# 3. 合并摘要 → data/tasks.json
node scripts/localize.mjs

# 4. 启动
npm start          # 默认 http://localhost:4321 ,可用 PORT 覆盖
```

> 没有 `data/tasks.json` 或某条摘要缺失时,该 rubric 显示「摘要生成中…」,
> 但仍可展开 judge 完整推理,应用始终可用 —— 摘要可增量补齐。

## 题目结构

- **featured(3 道)**:高/中/低分各一,所有专家进来先评这 3 道。
- **pool(其余)**:答完 featured 后,「再来 2 题」每轮从未评过的题库题中随机抽 2 道。
- 加题/换题:改 `extract.mjs` 的 `FEATURED` 数组与源 pool。

## 前端渲染说明

- **溯源标记脚注化**:报告/摘要里的 `[来源:类型|来源方|标题]` 在渲染时被替换为淡色上标角标(同源去重共号),悬停显示来源;报告末尾自动生成「参考来源」折叠列表。纯前端转换,不改原始数据,源信息仍可溯(对 source_authority 评分有用)。见 `public/app.js` 的 `parseCitations`。
- **评分依据为 AI 摘要**:每条 rubric 内联展示的是对 judge 推理的中文摘要,前端已显著标注「并非原始评审内容」,并保留「展开 judge 完整推理」查看原文。
- **不合理时追问松紧**:判「不合理」时追加偏向选项,落入 `overallTightness` / `perRubricTightness`。单条 rubric 为「评分过紧 / 评分过松 / 没必要评(`unnecessary`)」;总分为「评分过紧 / 评分过松 / 维度有问题(`wrong_dimensions`,评错或漏评了维度)」。

## 反馈数据格式(`data/feedback.jsonl`,每行一份提交;每轮一份)

```json
{
  "submittedAt": "ISO 时间",
  "sessionId": "同一专家一次会话的多轮共用",
  "round": 1,
  "respondent": { "name": "姓名", "institution": "机构" },
  "responses": [
    {
      "taskId": "q0001",
      "shownScore": 0.42,
      "blindReaction": "too_low | reasonable | too_high",
      "overallVerdict": "reasonable | unreasonable",
      "overallTightness": "too_strict | too_lenient | wrong_dimensions | null",
      "perRubric": { "data_quality": "reasonable | unreasonable" },
      "perRubricTightness": { "data_quality": "too_strict | too_lenient | unnecessary" },
      "note": "自由文本"
    }
  ],
  "meta": { "userAgent": "...", "durationMs": 12345 }
}
```

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/tasks` | `{ agent, featured:[完整3题], poolIds:[题库 id 列表] }` |
| GET | `/api/task/:id` | 返回单题完整数据(随机抽题时按需加载) |
| GET | `/api/progress?name=&institution=` | 该专家已评议的 taskId 列表(返回用户跳过 featured 用) |
| POST | `/api/feedback` | 校验后追加一份提交到 `feedback.jsonl`(并发安全,串行写入) |
| GET | `/api/stats` | 已收集提交数 |

> 题目数据(`data/tasks.json`、报告图片等)由流水线生成,不随仓库提交;
> 被测 Agent、源 pool/eval、featured 题号在 `scripts/extract.mjs` 顶部配置。
