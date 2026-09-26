<div align="center">

# Zotero Cool Paper

**拿来吧，你！把 papers.cool 的 KIMI 解读与 Zotero 本地相关论文发现带进侧边栏。**

[![Zotero](https://img.shields.io/badge/Zotero-7--9-CC2936?logo=zotero&logoColor=white)](https://www.zotero.org)
[![papers.cool](https://img.shields.io/badge/papers.cool-KIMI%20%2B%20REL-ff9800)](https://papers.cool)
[![Local REL](https://img.shields.io/badge/Zotero-Local%20REL-6750a4)](#-local-rel)

一个轻量 Zotero 插件，提供三个独立的条目侧边栏标签：`papers.cool` 阅读公开解读与在线 REL，`Local REL` 发现本地相关论文，`本地解读` 按需调用 Kimi K2.6 阅读自己的 PDF。

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

### 本地解读（0.1.18 测试版）

1. 选择附有本地 PDF 的条目，点击右侧「本地解读」图标；PDF 阅读器侧栏也有此入口。
2. 展开「API Key 与费用设置」，保存自己的 Kimi API Key。密钥使用 Zotero 密码管理器保存。
3. 选择 PDF，点击「生成解读」。一次请求生成六问，默认关闭思考；单次生成预估费用上限为 ¥0.50，可调整。
4. 点击每题下方的来源编号查看解析原文；编号对应段落，不能作为 PDF 页码引用。
5. 再次打开时直接读取本地结果；点击「重新生成」才再次付费调用。失败或取消会保留上一版成功结果，并保留本次草稿和可取得的用量。

重新生成复用相同 PDF 的解析正文，PDF 内容变化后按新文件处理。面板显示输入、输出、缓存 tokens 和带日期的费用估算；未收到用量时显示未知，不按零费用处理。

本版以文件接口解析的文字为依据，不自动补充扫描页或图片；模型解读仍需对照论文。来源编号用于定位解析段落，不能证明模型结论已完成事实核查。

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
- papers.cool 缓存内容仅保存在本地 Zotero SQLite 数据库表 `paperscool_cache`
- metadata 与 REL 缓存有效期为 7 天，KIMI 缓存有效期为 30 天；缓存最多保留 500 篇论文和 90 天，并可在 `papers.cool` 面板中手动清空
- `papers.cool` 面板的手动刷新会重新请求当前论文对应的在线内容；`Local REL` 刷新只会重新查询本地文献库
- 「本地解读」只在点击生成/重新生成后向 `https://api.moonshot.cn/v1` 发送所选 PDF 或缓存正文与六问提示词。不会上传整个资料库、附件路径或 API Key 配置文件；文件上传名固定为 `paper.pdf`
- 文件解析完成并保存到本机后即尝试删除本次云端文件。删除失败会记录待清理文件，面板设置提供手动重试；意外中断后在下次生成时重试同一 Key 的已记录文件。上传中断且未收到文件编号时，无法保证远端文件已删除，需检查 Kimi 文件管理
- 本地解析正文、原始模型响应、来源与用量保存在 `pcp_reading_*` 表中，不写入 Zotero 笔记，不通过 Zotero 同步，不自动过期。它们属于本机数据库备份的一部分。API Key 单独使用 Zotero 密码管理器保存，可从面板移除；开发密钥、PDF、实验结果不进入插件包
- 本地解读数据库操作屏蔽调试日志，数据库错误和 HTTP 错误使用固定提示，避免泄露正文与凭据

---

## 致谢

- 感谢苏神（苏剑林）做出的伟大 papers.cool 平台，让论文发现、筛选、KIMI 解读和相关论文探索变得优雅又高效
- 感谢 [windingwind/zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit)
- 本项目由 AndyBear 与 OpenAI Codex 协作开发，感谢这段从需求探索到调试打磨的 pair programming （本条由Codex生成）
