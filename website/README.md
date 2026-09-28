# deepseek-harness-jev 功能介绍站

这是独立的零依赖静态网站。`src/features.mjs` 保存 11 项功能与证据资料，`src/styles.css` 保存页面样式，`build.mjs` 生成首页、功能案例页和公开证据镜像。`dist/` 是构建产物，不纳入插件安装包。

```sh
node website/build.mjs
python3 -m http.server 4173 --directory website/dist
```

浏览 `http://localhost:4173/`。构建要求仓库中的公开证据文件存在，包括 `docs/testing/2026-09-27-jev-hooks/public-results.zh-CN.md`。构建先清理 `website/dist/`，再把公开证据转为可在本地和 GitHub Pages 中阅读的纯文本 HTML 页。网站内部链接使用相对路径，可部署到项目子路径。构建不需要安装依赖，也不修改插件运行文件。

功能资料中的 `mechanism` 记录触发、交给 Jev 的输入及宿主如何采用，可用 `seams` 列出原生接入点；`cases` 按具名任务记录执行核查、观察和结果解释。案例的 `evidence` 使用资料文件顶部的公开证据 key，`references` 指向仓库公开源码。`homeEvidence` 是概览卡上的一句实测结果。页面生成器兼容旧字段，方便逐项更新资料。
