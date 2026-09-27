/** Copy for the Jev configuration and decision-record pages. */

/** Dictionary keys rendered by the Jev page. */
export type JevLocaleKey =
  | 'webMaxObserve' | 'webMaxScrollCandidates' | 'webLimits' | 'webLimitsHint' | 'webMaxRounds' | 'webNoProgress' | 'webMaxCandidates' | 'webHistory' | 'webEvidence' | 'webScroll' | 'webResultSteps' | 'webInvalid' | 'webSave' | 'webSaved' | 'webSaveFailed'
  | 'sharedFindingsName' | 'sharedFindingsDescription'
  | 'tabs' | 'settings' | 'records' | 'connection' | 'features' | 'noFeatures'
  | 'baseUrl' | 'model' | 'credentialRef' | 'timeoutMs' | 'apiKey' | 'apiKeyHint'
  | 'configured' | 'missing' | 'readOnly' | 'unavailable' | 'loading'
  | 'saveConnection' | 'saveFirst' | 'saving' | 'saveFailed' | 'saveSuccess' | 'invalidTimeout'
  | 'selectionCounts' | 'skillSummaryCount' | 'fileRankingMaximum' | 'rankedPathCount'
  | 'selectionCountsHint' | 'selectionCountInvalid' | 'saveSelectionCounts' | 'selectionCountSaved' | 'selectionCountSaveFailed'
  | 'evidenceChars' | 'supervisionCounts' | 'driftInterval' | 'noProgressRounds' | 'supervisionCountsHint' | 'supervisionCountInvalid' | 'saveSupervisionCounts' | 'supervisionCountSaved' | 'supervisionCountSaveFailed'
  | 'replaceKey' | 'saveKey' | 'keySaved' | 'keySaveFailed' | 'testConnection'
  | 'testing' | 'testSucceeded' | 'testFailed' | 'latency' | 'enable' | 'disable' | 'refreshFeatures'
  | 'featureSaveFailed' | 'featureLoadFailed' | 'retry' | 'allFeatures'
  | 'allStatuses' | 'sessionId' | 'applyFilters' | 'refresh' | 'noRecords'
  | 'recordsFailed' | 'loadMore' | 'details' | 'closeDetails' | 'detailFailed'
  | 'operation' | 'attempts' | 'receipts' | 'input' | 'questions'
  | 'answer' | 'rawAnswer' | 'connectionIdentity' | 'usage' | 'failure' | 'interpretation' | 'actualAction' | 'time'
  | 'status' | 'feature' | 'kind' | 'noDetail' | 'diagnostic'
  | 'pending' | 'waiting' | 'succeeded' | 'failed' | 'cancelled'
  | 'interrupted' | 'unconfirmed' | 'notAdopted' | 'executed' | 'executionFailed' | 'observed'

/** English copy. */
export const en: Record<JevLocaleKey, string> = {
  webLimits: 'Native webpage goals', webLimitsHint: 'These limits apply only to explicit webpage goals. Native tools remain available. Reading again also consumes a decision round. Changes apply to new runs.',
  webMaxObserve: 'Consecutive reobservations', webMaxScrollCandidates: 'Scroll candidates',
  webMaxRounds: 'Decision rounds', webNoProgress: 'Unchanged observations', webMaxCandidates: 'Executable candidates', webHistory: 'Recent steps in judgments', webEvidence: 'Page evidence characters', webScroll: 'Scroll distance (CSS pixels)', webResultSteps: 'Steps in result summary', webInvalid: 'Enter whole numbers within the displayed ranges.', webSave: 'Save webpage limits', webSaved: 'Webpage limits saved.', webSaveFailed: 'Could not save webpage limits.',
  sharedFindingsName: 'Shared finding corrections', sharedFindingsDescription: 'Compare already shared reports and messages, correct actual recipients, and ask the root to verify conflicts.',
  tabs: 'Jev pages', settings: 'Settings and features', records: 'Decision records',
  connection: 'Shared connection', features: 'Features', noFeatures: 'No features are registered yet.',
  baseUrl: 'Service address', model: 'Model', credentialRef: 'Credential reference', timeoutMs: 'Timeout (ms)',
  apiKey: 'API key', apiKeyHint: 'Saved in Host credentials. This field never shows the saved key.',
  configured: 'Configured', missing: 'Missing', readOnly: 'Read-only', unavailable: 'Settings are unavailable.', loading: 'Loading…',
  saveConnection: 'Save connection', saveFirst: 'Save the connection before changing its key or testing it.', saving: 'Saving…', saveFailed: 'Could not save these settings.', saveSuccess: 'Connection settings saved.', invalidTimeout: 'Enter a positive timeout in milliseconds.',
  selectionCounts: 'Selection counts', skillSummaryCount: 'Skill summaries shown', fileRankingMaximum: 'Maximum glob files for Jev ranking', rankedPathCount: 'Ranked paths shown',
  selectionCountsHint: 'If glob finds more files than the ranking maximum, Jev is skipped and the original glob result is returned.',
  selectionCountInvalid: 'Enter a positive whole number.', saveSelectionCounts: 'Save selection counts', selectionCountSaved: 'Selection counts saved.', selectionCountSaveFailed: 'Could not save selection counts.',
  evidenceChars: 'Evidence character budget', supervisionCounts: 'Supervision counts', driftInterval: 'Completed model steps between drift checks', noProgressRounds: 'Consecutive goal rounds without progress', supervisionCountsHint: 'All three supervision features are independent and disabled by default. Native goal round limits still apply.', supervisionCountInvalid: 'Enter a positive whole number.', saveSupervisionCounts: 'Save supervision counts', supervisionCountSaved: 'Supervision counts saved.', supervisionCountSaveFailed: 'Could not save supervision counts.',
  replaceKey: 'Replace key', saveKey: 'Save key', keySaved: 'Key saved.', keySaveFailed: 'Could not save the key.',
  testConnection: 'Test connection', testing: 'Testing…', testSucceeded: 'Connection test passed.', testFailed: 'Connection test failed.', latency: 'Latency',
  enable: 'Enable', disable: 'Disable', refreshFeatures: 'Refresh features', featureSaveFailed: 'Could not change this feature.', featureLoadFailed: 'Could not load features.', retry: 'Retry',
  allFeatures: 'All features', allStatuses: 'All statuses', sessionId: 'Session ID', applyFilters: 'Apply filters', refresh: 'Refresh', noRecords: 'No decision records match these filters.',
  recordsFailed: 'Could not refresh records. Existing records are still shown.', loadMore: 'Load more', details: 'Details', closeDetails: 'Close details', detailFailed: 'Could not load this record.',
  operation: 'Operation', attempts: 'Attempts', receipts: 'Action receipts', input: 'Input state', questions: 'Questions', answer: 'Validated answer', rawAnswer: 'Raw response', connectionIdentity: 'Connection', usage: 'Reported usage', failure: 'Failure', interpretation: 'Interpretation', actualAction: 'Actual action', time: 'Time',
  status: 'Status', feature: 'Feature', kind: 'Kind', noDetail: 'No details for this record.', diagnostic: 'Connection diagnostic',
  pending: 'Pending', waiting: 'Waiting', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled',
  interrupted: 'Interrupted', unconfirmed: 'Unconfirmed', notAdopted: 'Not adopted', executed: 'Executed', executionFailed: 'Execution failed', observed: 'Observed',
}

/** Simplified Chinese copy. */
export const zh: Record<JevLocaleKey, string> = {
  webLimits: 'Native 网页目标执行', webLimitsHint: '限制只作用于明确调用的网页目标；普通 Native 工具保持可用。重新观察也占一个决策轮次。修改应用于新运行。',
  webMaxObserve: '连续重新观察上限', webMaxScrollCandidates: '滚动候选数上限',
  webMaxRounds: '决策轮次上限', webNoProgress: '连续无变化观察次数', webMaxCandidates: '可执行候选数', webHistory: '判断携带的近期步骤数', webEvidence: '页面证据字符数', webScroll: '滚动距离（CSS 像素）', webResultSteps: '结果摘要步骤数', webInvalid: '请输入显示范围内的整数', webSave: '保存网页执行限制', webSaved: '网页执行限制已保存', webSaveFailed: '无法保存网页执行限制',
  sharedFindingsName: '共享发现纠正', sharedFindingsDescription: '比较已共享报告和消息，纠正实际接收者，并将冲突交给主代理核实。',
  tabs: 'Jev 页面', settings: '设置与功能', records: '判断记录',
  connection: '共用连接', features: '功能目录', noFeatures: '当前没有登记的功能',
  baseUrl: '服务地址', model: '模型', credentialRef: '凭据引用', timeoutMs: '超时（毫秒）',
  apiKey: 'API 密钥', apiKeyHint: '写入宿主凭据；这里不会读回已保存的密钥',
  configured: '已配置', missing: '缺失', readOnly: '只读', unavailable: '设置暂不可用', loading: '加载中…',
  saveConnection: '保存连接', saveFirst: '请先保存连接，再替换密钥或测试连接', saving: '保存中…', saveFailed: '无法保存这些设置', saveSuccess: '连接设置已保存', invalidTimeout: '请输入正整数毫秒数',
  selectionCounts: '筛选数量', skillSummaryCount: '展示的技能摘要数', fileRankingMaximum: 'Jev 排序最大文件数', rankedPathCount: '展示的已排序路径数',
  selectionCountsHint: 'glob 匹配文件数超过排序上限时，跳过 Jev，直接返回原 glob 结果',
  selectionCountInvalid: '请输入正整数', saveSelectionCounts: '保存筛选数量', selectionCountSaved: '筛选数量已保存', selectionCountSaveFailed: '无法保存筛选数量',
  evidenceChars: '已有证据字符预算', supervisionCounts: '执行监督次数', driftInterval: '跑偏检查间隔（已完成模型步骤）', noProgressRounds: '连续无进展目标轮数', supervisionCountsHint: '三项监督功能独立开关，默认关闭；目标总轮数仍遵守原生上限', supervisionCountInvalid: '请输入正整数', saveSupervisionCounts: '保存监督次数', supervisionCountSaved: '监督次数已保存', supervisionCountSaveFailed: '无法保存监督次数',
  replaceKey: '替换密钥', saveKey: '保存密钥', keySaved: '密钥已保存', keySaveFailed: '无法保存密钥',
  testConnection: '测试连接', testing: '测试中…', testSucceeded: '连接测试通过', testFailed: '连接测试失败', latency: '耗时',
  enable: '启用', disable: '关闭', refreshFeatures: '刷新功能', featureSaveFailed: '无法修改此功能', featureLoadFailed: '无法加载功能目录', retry: '重试',
  allFeatures: '全部功能', allStatuses: '全部状态', sessionId: '会话 ID', applyFilters: '应用筛选', refresh: '刷新', noRecords: '没有符合条件的判断记录',
  recordsFailed: '无法刷新记录，已保留现有内容', loadMore: '加载更多', details: '详情', closeDetails: '关闭详情', detailFailed: '无法加载这条记录',
  operation: '操作', attempts: '尝试', receipts: '动作回执', input: '输入状态', questions: '问题', answer: '已校验回答', rawAnswer: '原始响应', connectionIdentity: '连接身份', usage: '服务报告用量', failure: '失败原因', interpretation: '业务解释', actualAction: '实际动作', time: '时间',
  status: '状态', feature: '功能', kind: '类型', noDetail: '这条记录没有详情', diagnostic: '连接诊断',
  pending: '进行中', waiting: '等待处理', succeeded: '判断成功', failed: '失败', cancelled: '已取消',
  interrupted: '已中断', unconfirmed: '未确认', notAdopted: '未采用', executed: '已执行', executionFailed: '执行失败', observed: '已观察',
}
