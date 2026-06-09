export const meta = {
  name: 'summarize-judge-reasoning',
  description: 'Summarize each rubric judge reasoning into 2-3 Chinese sentences for all tasks',
  phases: [{ title: 'Summarize', detail: 'one agent per task, reads its reasoning file' }],
}

// Absolute path to this repo's data/reasonings dir on the machine running the
// workflow (sub-agents Read these files). Pass via args.reasoningsDir or edit.
const DIR = (args && args.reasoningsDir) || '<ABSOLUTE_PATH>/data/reasonings'
// Task ids to summarize. Pass via args.taskIds, or list them here.
const TASK_IDS = (args && args.taskIds) || []

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    taskId: { type: 'string' },
    summaries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rubricId: { type: 'string' },
          summary: { type: 'string', description: '2-3 句简体中文摘要' },
        },
        required: ['rubricId', 'summary'],
      },
    },
  },
  required: ['taskId', 'summaries'],
}

phase('Summarize')

const results = await parallel(
  TASK_IDS.map((taskId) => () =>
    agent(
      `读取文件:${DIR}/${taskId}.json\n\n` +
        `该 JSON 文件是一道金融研究题(taskId=${taskId})的若干评分维度(rubric)的「judge 评分推理」原文(英文或中英混杂,内容很长)。\n` +
        `请用 Read 工具读取该文件,然后为其中的【每一条】rubric 写一段简体中文摘要,要求:\n` +
        `- 每条 2-3 句话,客观转述 judge 主要因为什么给出/扣掉这个分数、核心依据是什么(例如发现了哪些数据错误、缺了什么分析、覆盖了哪些用户需求等)。\n` +
        `- 保留关键的数字、比例与具体事实点。\n` +
        `- 只转述 judge 的判断逻辑,不要评价 judge 对错,不要加任何前言或结语。\n` +
        `- summary 用纯文本(可用顿号、分号分隔要点),不要用 markdown 标题。\n` +
        `返回 taskId 以及每条 rubric 的 rubricId 与对应 summary,rubricId 必须与文件中的完全一致,且覆盖文件中的全部 rubric。`,
      { label: taskId, phase: 'Summarize', schema: SCHEMA },
    ),
  ),
)

const ok = results.filter(Boolean)
log(`summarized ${ok.length}/${TASK_IDS.length} tasks`)
return { tasks: ok }
