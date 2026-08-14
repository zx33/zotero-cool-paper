<div align="center">

# Zotero Cool Paper

**拿来吧，你！把 papers.cool 的 KIMI 解读与 Zotero 本地相关论文发现带进侧边栏。**

[![Zotero](https://img.shields.io/badge/Zotero-7--9-CC2936?logo=zotero&logoColor=white)](https://www.zotero.org)
[![papers.cool](https://img.shields.io/badge/papers.cool-KIMI%20%2B%20REL-ff9800)](https://papers.cool)
[![Local REL](https://img.shields.io/badge/Zotero-Local%20REL-6750a4)](#-local-rel)

一个轻量 Zotero 插件，提供两个彼此独立的条目侧边栏面板：`papers.cool` 面板用于阅读 KIMI 解读与在线 REL，`Local REL` 面板则完全基于当前 Zotero 文献库发现本地相关论文。

_Fully powered by OAI Codex_

</div>

---

## ✨ 核心亮点

|                             |                                                                           |
| --------------------------- | ------------------------------------------------------------------------- |
| 🧠 **KIMI 解读进 Zotero**   | 不用离开 Zotero，直接在条目侧边栏阅读 papers.cool 的 KIMI 论文问答式解读  |
| 🔗 **REL 相关论文折叠展示** | 自动读取 papers.cool 关键词检索相关论文，并以折叠区块展示                 |
| 🗂️ **Local REL 本地发现**   | 从当前条目的标签、标题与摘要提取关键词，只检索当前 Zotero 文献库          |
| 📖 **双击直达本地论文**     | 双击 Local REL 结果优先打开本地 PDF；没有 PDF 时自动定位到对应条目        |
| 🧭 **多来源论文识别**       | 支持 arXiv ID、papers.cool URL、OpenReview / venue 条目，以及标题兜底搜索 |
| ⚡ **支持长流式响应**       | 对尚未生成 star 的 KIMI 解读，支持 1–3 分钟流式 POST，边生成边预览        |
| 💾 **本地缓存与刷新**       | 使用 Zotero SQLite 本地缓存 metadata / KIMI / REL，提供刷新按钮手动更新   |

---

## 🗂️ Local REL

`Local REL` 与 `papers.cool` 是两个独立面板。它不要求论文被 papers.cool 收录，也不会向外部服务发送本地文献内容。

1. 优先使用当前 Zotero 条目的标签作为检索词
2. 从标题和摘要提取实体与多词短语，并将关键词划分为核心、领域和辅助层级
3. 调用 Zotero 自带搜索索引，在当前资料库的标题、标签、摘要和全文中查找候选论文
4. 结合字段命中、本地词频稀有度和主题相关性门槛排序，过滤仅命中宽泛单词的弱相关结果
5. 双击结果优先在 Zotero 阅读器中打开本地 PDF；没有本地 PDF 时定位到对应条目

---

## 安装

### 从发布包安装

1. 下载 `.xpi` 插件文件
2. 打开 Zotero → 工具 → 插件
3. 点击齿轮图标 → `Install Add-on From File...`
4. 选择 `.xpi` 文件并重启 Zotero

> 当前插件面向 Zotero 7–9；开发环境主要验证于 Zotero 9。

### 本地构建安装

```bash
npm install
npm run build
```

构建产物位于：

```text
.scaffold/build/zotero-cool-paper.xpi
```

---

## 隐私说明

- `papers.cool` 面板只请求公开的 papers.cool 页面与接口
- `Local REL` 面板完全在本地运行，不请求 papers.cool，也不会上传 Zotero 条目、标签、摘要或全文
- 缓存内容仅保存在本地 Zotero SQLite 数据库表 `paperscool_cache`
- `papers.cool` 面板的手动刷新会重新请求当前论文对应的在线内容；`Local REL` 刷新只会重新查询本地文献库

---

## 致谢

- 感谢苏神（苏剑林）做出的伟大 papers.cool 平台，让论文发现、筛选、KIMI 解读和相关论文探索变得优雅又高效
- 感谢 [windingwind/zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit)
- 本项目由 AndyBear 与 OpenAI Codex 协作开发，感谢这段从需求探索到调试打磨的 pair programming （本条由Codex生成）
