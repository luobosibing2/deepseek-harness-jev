import { readFile, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { evidence, features, groups } from './src/features.mjs';

const website = dirname(fileURLToPath(import.meta.url));
const repository = resolve(website, '..');
const output = join(website, 'dist');
const github = 'https://github.com/luobosibing2/deepseek-harness-jev';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function page({ title, description, depth = '', body }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="description" content="${escapeHtml(`deepseek-harness-jev 是 DeepSeek Harness（DSH）的独立社区插件，接入 TypeSafe Jev / System One 判断。${description}`)}">
  <title>${escapeHtml(title)} · deepseek-harness-jev｜DeepSeek Harness（DSH）与 TypeSafe Jev / System One</title>
  <link rel="stylesheet" href="${depth}assets/site.css">
</head>
<body>
  <a class="skip-link" href="#main">跳到正文</a>
  <header class="site-header"><div class="shell site-header__inner">
    <a class="brand" href="${depth}index.html" aria-label="deepseek-harness-jev 首页"><span class="brand__glyph" aria-hidden="true">d<span>/</span>j</span><span>deepseek-harness-jev</span></a>
    <nav class="top-nav" aria-label="主导航"><a href="${depth}index.html#features">功能与案例</a><a href="${depth}index.html#evidence">验证口径</a><a href="${depth}index.html#install">安装</a><a href="${github}" target="_blank" rel="noopener noreferrer">仓库 ↗</a></nav>
  </div></header>
  <main id="main">${body}</main>
  <footer class="site-footer"><div class="shell site-footer__inner"><p>独立社区项目 · 内容来自公开测试记录，不代表普遍语义正确性。</p><a href="${github}/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">MIT 许可证 ↗</a></div></footer>
</body>
</html>`;
}

function status(feature) {
  return `<span class="status status--${escapeHtml(feature.tone)}">${escapeHtml(feature.status)}</span>`;
}

function featureHref(feature, depth = '') {
  return `${depth}features/${feature.slug}.html`;
}

function homePage() {
  const featureGroups = groups.map((group) => {
    const cards = features.filter((feature) => feature.group === group.id).map((feature) => `<a class="feature-card" href="${featureHref(feature)}"><span class="feature-card__meta">${status(feature)}<span aria-hidden="true">↗</span></span><h4>${escapeHtml(feature.name)}</h4><p>${escapeHtml(feature.summary)}</p><span class="feature-card__evidence">${escapeHtml(feature.homeEvidence ?? feature.observed?.[0] ?? '查看测试结果与边界。')}</span></a>`).join('');
    return `<section class="feature-group" aria-labelledby="group-${group.id}"><div class="feature-group__heading"><h3 id="group-${group.id}">${escapeHtml(group.title)}</h3><p>${escapeHtml(group.description)}</p></div><div class="feature-grid">${cards}</div></section>`;
  }).join('');
  const body = `
  <section class="hero shell" aria-labelledby="hero-title"><div class="hero__copy"><p class="eyebrow">deepseek-harness-jev / 功能与实测</p><h1 id="hero-title">DSH 继续执行。<br>Jev 在需要判断处介入。</h1><p class="hero__lead">主 Agent 负责规划、工具调用与回答；TypeSafe Jev / System One 在已启用的 DSH 原生扩展点提供判断。11 项功能分别开启，默认全部关闭。</p><a class="text-link" href="#features">逐项查看功能与案例 <span aria-hidden="true">↓</span></a></div><aside class="hook-trace" aria-labelledby="hook-trace-title"><div class="hook-trace__heading"><span>源码接入点</span><h2 id="hook-trace-title">典型的三处判断</h2></div><ul><li><code>agent/pre-step</code><span>发布技能目录前，整理技能摘要。</span><a href="${github}/blob/main/packages/jev/src/selection.ts" target="_blank" rel="noopener noreferrer" aria-label="查看技能选择实现">↗</a></li><li><code>tools/post-execute</code><span>命令返回后，评估可省略的日志。</span><a href="${github}/blob/main/packages/jev/src/output-admission.ts" target="_blank" rel="noopener noreferrer" aria-label="查看日志准入实现">↗</a></li><li><code>approval/request</code><span>适用的单次提权请求进入原生审批。</span><a href="${github}/blob/main/packages/jev/src/workspace-approval.ts" target="_blank" rel="noopener noreferrer" aria-label="查看工作区审批实现">↗</a></li></ul><p>这些是三个独立例子，并非任务必须依次经过的步骤。</p></aside></section>
  <section class="flow shell" aria-labelledby="flow-title"><div class="section-heading"><p class="eyebrow">工作方式</p><h2 id="flow-title">一次判断放在原生流程之内。</h2></div><ol class="flow__steps"><li><span>DSH 主 Agent</span><small>规划与调用工具</small></li><li><span>原生扩展点</span><small>只接入已启用功能</small></li><li><span>Jev 判断</span><small>返回选择或评估</small></li><li><span>DSH 记录</span><small>核对交付与实际执行</small></li></ol><p class="flow__note">插件不替代主模型，也不修改 DSH 宿主源码。判断成功和操作成功是两件事。</p></section>
  <section class="evidence-overview shell" id="evidence" aria-labelledby="evidence-title"><div class="section-heading"><p class="eyebrow">两条真实观察</p><h2 id="evidence-title">数字与失败，按同一口径呈现。</h2><p>下面分别是一条单次量化结果和一条未通过的语义负例；都不能推广为整体效果。</p></div><div class="observation-grid"><a href="features/long-log-admission.html" class="observation"><span>单次构建日志 · 隔离真实 profile</span><strong>75.7%</strong><p>交给 Agent 的文本从 8,510 缩至 2,072 字符，产物哈希保留。没有测得平均节省。</p><span class="observation__link">查看日志准入案例 ↗</span></a><a href="features/completion-check.html" class="observation observation--negative"><span>完成核查 · 真实语义负例</span><strong>未通过</strong><p>主模型声称“没有新增文件”，Jev 放行了缺少依据的声明；两次重放仍未指出问题。</p><span class="observation__link">查看完成核查案例 ↗</span></a></div><p class="evidence-overview__note">阅读口径：流程测试只说明接线可运行；未测前后差异的功能写明效果尚未量化。<a href="evidence/validation.html">查看验证范围 ↗</a></p></section>
  <section class="catalog shell" id="features" aria-labelledby="features-title"><div class="section-heading"><p class="eyebrow">11 项独立功能</p><h2 id="features-title">按用途阅读，再进入具体案例。</h2><p>每页说明触发时机、Jev 收到什么、宿主怎样采用判断，以及已发生的测试结果。</p></div>${featureGroups}</section>
  <section class="install shell" id="install" aria-labelledby="install-title"><div><p class="eyebrow">开始使用</p><h2 id="install-title">在 DSH Web 中安装。</h2><p>已针对 DSH 0.1.7-rc.2 Web 验证。在「插件」→「添加插件」中粘贴仓库地址，安装并启用插件；之后在 Jev 页面配置连接，再单独开启需要的功能。DSH 主模型与 Jev 判断连接分别配置。</p><p class="install__note">11 项功能在安装后仍默认关闭。历史 v0.1.0 安装包不含较新的日志筛选功能。</p></div><div class="install__address"><span>仓库地址</span><code>${github}</code><a href="${github}/blob/main/README.zh-CN.md#网页端安装推荐" target="_blank" rel="noopener noreferrer">阅读完整安装说明 ↗</a></div></section>`;
  return page({ title: '功能与实测结果', description: '11 项功能的触发机制、具体测试案例、实际结果与限制。', body });
}

function referenceLinks(references = []) {
  return references.map((reference) => `<a href="${github}/blob/main/${reference.file}${reference.anchor ?? ''}" target="_blank" rel="noopener noreferrer">${escapeHtml(reference.title)} ↗</a>`).join('');
}

function evidenceLinks(keys = []) {
  return keys.filter((key) => evidence[key]).map((key) => `<a href="../evidence/${evidence[key].slug}.html">${escapeHtml(evidence[key].title)} ↗</a>`).join('');
}

function mechanismFor(feature) {
  return feature.mechanism ?? {
    trigger: feature.scenarios?.[0] ?? '见公开功能说明。',
    input: feature.intro,
    handling: feature.summary,
    refs: feature.references ?? [],
  };
}

function casesFor(feature) {
  return feature.cases?.length ? feature.cases : [{
    kind: '公开验收', title: `${feature.name}的已记录结果`,
    task: feature.scenarios?.join(' '),
    probe: '对照工具结果、会话记录与判断记录。',
    result: feature.observed?.join(' '),
    reading: feature.impact,
    evidence: feature.sources,
    references: feature.references,
  }];
}

function mechanismSection(feature) {
  const mechanism = mechanismFor(feature);
  const seams = mechanism.seams?.length ? `<div class="mechanism__seams"><span>原生接入点</span><ul>${mechanism.seams.map((seam) => `<li><code>${escapeHtml(seam)}</code></li>`).join('')}</ul></div>` : '';
  return `<section class="mechanism" aria-labelledby="mechanism-title"><div class="section-heading"><p class="eyebrow">接入方式</p><h2 id="mechanism-title">这项判断如何进入任务</h2></div>${seams}<dl class="mechanism__steps"><div><dt>触发</dt><dd>${escapeHtml(mechanism.trigger)}</dd></div><div><dt>送给 Jev</dt><dd>${escapeHtml(mechanism.input)}</dd></div><div><dt>如何采用</dt><dd>${escapeHtml(mechanism.handling)}</dd></div></dl>${mechanism.refs?.length ? `<p class="mechanism__refs">实现依据：${referenceLinks(mechanism.refs)}</p>` : ''}</section>`;
}

function caseSection(testCase, feature, index, featuredIndex) {
  const links = [evidenceLinks(testCase.evidence ?? (index === 0 ? feature.sources : [])), referenceLinks(testCase.references ?? (index === 0 ? feature.references : []))].filter(Boolean).join('');
  return `<section class="case${index === featuredIndex ? ' case--lead' : ''}" aria-labelledby="case-${index}"><div class="case__heading"><span class="case__kind">${escapeHtml(testCase.kind ?? '测试案例')}</span><h2 id="case-${index}">${escapeHtml(testCase.title)}</h2></div><p class="case__task">${escapeHtml(testCase.task)}</p><p class="case__probe"><span>执行与核查</span>${escapeHtml(testCase.probe)}</p><div class="case__finding"><span>实际观察</span><p>${escapeHtml(testCase.result)}${links ? `<span class="case__sources">证据：${links}</span>` : ''}</p></div>${testCase.reading ? `<p class="case__reading">${escapeHtml(testCase.reading)}</p>` : ''}</section>`;
}

function detailPage(feature) {
  const group = groups.find((candidate) => candidate.id === feature.group);
  const testCases = casesFor(feature);
  const featuredIndex = testCases.findIndex((testCase) => testCase.kind?.includes('真实'));
  const limits = feature.limits?.length ? `<div class="detail-limits"><h2>这些结果的边界</h2><ul>${feature.limits.map((limit) => `<li>${escapeHtml(limit)}</li>`).join('')}</ul></div>` : '';
  const next = features[features.indexOf(feature) + 1];
  const body = `<div class="detail shell"><nav class="breadcrumbs" aria-label="当前位置"><a href="../index.html#features">11 项功能</a><span aria-hidden="true">/</span><span>${escapeHtml(group.title)}</span><span aria-hidden="true">/</span><span aria-current="page">${escapeHtml(feature.name)}</span></nav><article><header class="detail__header"><div class="detail__meta"><span>${escapeHtml(group.title)}</span>${status(feature)}</div><h1>${escapeHtml(feature.name)}</h1><p class="detail__summary">${escapeHtml(feature.summary)}</p><p class="detail__intro">${escapeHtml(feature.intro)}</p></header>${mechanismSection(feature)}<div class="case-list">${testCases.map((testCase, index) => caseSection(testCase, feature, index, featuredIndex)).join('')}${limits}</div><nav class="detail-next" aria-label="继续阅读"><a href="../index.html#features">← 返回功能概览</a>${next ? `<a href="${next.slug}.html">下一项：${escapeHtml(next.name)} →</a>` : ''}</nav></article></div>`;
  return page({ title: feature.name, description: `${feature.name}：${feature.summary}查看接入方式、测试案例与实际结果。`, depth: '../', body });
}

function evidencePage(source, content) {
  const original = `${github}/blob/main/${source.file}`;
  const body = `<div class="evidence-page shell"><nav class="breadcrumbs" aria-label="当前位置"><a href="../index.html">功能概览</a><span aria-hidden="true">/</span><span aria-current="page">公开证据</span></nav><header><p class="eyebrow">公开记录</p><h1>${escapeHtml(source.title)}</h1><p>以下为仓库 Markdown 原文字句，原文中的链接请到仓库页面使用。</p><a href="${original}" target="_blank" rel="noopener noreferrer">打开仓库原文 ↗</a></header><pre class="evidence-text">${escapeHtml(content)}</pre></div>`;
  return page({ title: source.title, description: `${source.title}的公开记录。`, depth: '../', body });
}

if (features.length !== 11 || new Set(features.map((feature) => feature.slug)).size !== features.length) {
  throw new Error('功能清单必须包含 11 个不重复的页面');
}
const sourceContents = await Promise.all(Object.values(evidence).map(async (source) => ({
  source,
  content: await readFile(join(repository, source.file), 'utf8'),
})));
await rm(output, { recursive: true, force: true });
await mkdir(join(output, 'assets'), { recursive: true });
await mkdir(join(output, 'features'), { recursive: true });
await mkdir(join(output, 'evidence'), { recursive: true });
await copyFile(join(website, 'src/styles.css'), join(output, 'assets/site.css'));
await writeFile(join(output, 'index.html'), homePage());
for (const feature of features) {
  await writeFile(join(output, 'features', `${feature.slug}.html`), detailPage(feature));
}
for (const { source, content } of sourceContents) {
  await writeFile(join(output, 'evidence', `${source.slug}.html`), evidencePage(source, content));
}
console.log(`已构建 1 个首页、${features.length} 个功能页、${Object.keys(evidence).length} 个公开证据页：${output}`);
