<div align="center">

# Zotero Cool Paper

**拿来吧，你！把 papers.cool 的 KIMI 论文解读与 REL 相关论文带进 Zotero 侧边栏。**

[![Zotero](https://img.shields.io/badge/Zotero-7--9-CC2936?logo=zotero&logoColor=white)](https://www.zotero.org)
[![papers.cool](https://img.shields.io/badge/papers.cool-KIMI%20%2B%20REL-ff9800)](https://papers.cool)

一个轻量 Zotero 插件：识别 arXiv / papers.cool / OpenReview 条目，自动抓取 papers.cool 已生成或流式生成中的 KIMI 解读，并把 REL 相关论文按时间排序展示在论文侧边栏。

*Fully powered by OAI Codex*

</div>

---

## ✨ 核心亮点

|                             |                                                                           |
| --------------------------- | ------------------------------------------------------------------------- |
| 🧠 **KIMI 解读进 Zotero**   | 不用离开 Zotero，直接在条目侧边栏阅读 papers.cool 的 KIMI 论文问答式解读  |
| 🔗 **REL 相关论文折叠展示** | 自动读取 papers.cool 关键词检索相关论文，并以折叠区块展示                 |
| 🧭 **多来源论文识别**       | 支持 arXiv ID、papers.cool URL、OpenReview / venue 条目，以及标题兜底搜索 |
| ⚡ **支持长流式响应**       | 对尚未生成 star 的 KIMI 解读，支持 1–3 分钟流式 POST，边生成边预览        |
| 💾 **本地缓存与刷新**       | 使用 Zotero SQLite 本地缓存 metadata / KIMI / REL，提供刷新按钮手动更新   |

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

- 插件只请求公开的 papers.cool 页面与接口
- 缓存内容仅保存在本地 Zotero SQLite 数据库表 `paperscool_cache`
- 手动刷新只会重新请求当前论文对应的 papers.cool 内容

---

## 致谢

- 感谢苏神（苏剑林）做出的伟大 papers.cool 平台，让论文发现、筛选、KIMI 解读和相关论文探索变得优雅又高效
- 感谢 [windingwind/zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit)
- 本项目由 AndyBear 与 OpenAI Codex 协作开发，感谢这段从需求探索到调试打磨的 pair programming （本条由Codex生成）