<div align="center">

# Zotero Cool Paper

**拿来吧，你！把 papers.cool 的 KIMI 解读与 Zotero 本地相关论文发现带进侧边栏。**

[![Zotero](https://img.shields.io/badge/Zotero-7--10-CC2936?logo=zotero&logoColor=white)](https://www.zotero.org)
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

## 安装与版本选择

两个版本都支持 **Zotero 7–10**，并在 macOS 的 **Zotero 10.0.6** 上验证三个侧栏面板与 Local REL。

| 版本                      | 本地 Kimi 解读                                                          | 下载                                                                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **v0.1.18 稳定版**        | 保留原有单次六问、流式返回、来源段落与费用上限设置；加入 Zotero 10 兼容 | [安装包](https://github.com/zx33/zotero-cool-paper/releases/download/v0.1.18/zotero-cool-paper.xpi) · [发布说明](https://github.com/zx33/zotero-cool-paper/releases/tag/v0.1.18)               |
| **v0.1.19-beta.1 测试版** | Kimi K2.6 Batch，每题独立请求，解析复用，完整 Markdown 回答与费用显示   | [安装包](https://github.com/zx33/zotero-cool-paper/releases/download/v0.1.19-beta.1/zotero-cool-paper.xpi) · [发布说明](https://github.com/zx33/zotero-cool-paper/releases/tag/v0.1.19-beta.1) |

稳定版自动更新只推送正式版本；Beta 需要手动安装。两个版本使用同一插件 ID，安装其中一个会替换另一个。由 Beta 切回稳定版前，请先等待正在运行的 Batch 完成或在 Beta 中取消批次；关闭 Zotero 不会停止云端任务。

### 从发布包安装

1. 下载上表中所需版本的 `.xpi` 文件。
2. 打开 Zotero → 工具 → 插件。
3. 点击齿轮图标 → `Install Add-on From File...`。
4. 选择 `.xpi` 文件并重启 Zotero。

### 稳定版：原有本地解读

1. 选择附有本地 PDF 的条目，点击右侧「本地解读」图标；PDF 阅读器侧栏也有此入口。
2. 展开「API Key 与费用设置」，保存自己的 Kimi API Key。密钥使用 Zotero 密码管理器保存。
3. 选择 PDF，点击「生成解读」。保留 v0.1.18-beta.2 的原有流程：使用 Kimi K2.6，一次请求生成六问，默认关闭思考；单次生成预估费用上限默认为 ¥0.50，可调整。
4. 点击每题下方的来源编号查看解析原文；编号对应解析段落，不是 PDF 页码。
5. 再次打开时读取本地结果；点击「重新生成」才再次调用。失败或取消会保留上一版成功结果，以及本次草稿和可取得的用量。

相同 PDF 的解析正文可以复用。面板显示输入、输出、缓存 tokens 和带日期的费用估算；未收到用量时显示未知。

### Beta：Kimi Batch 六问解读

1. 在「本地解读」面板展开「API Key 与费用说明」，保存自己的 Kimi API Key。
2. 选择 PDF，点击「生成六问」。使用 Kimi K2.6 并开启思考，将六个独立请求提交为一个 Batch；每个请求包含同一份 general prompt、完整解析文本和一个问题。
3. Batch 在云端异步处理，完成窗口为 24 小时。关闭 Zotero 后任务继续执行，重新打开时自动查询并保存结果；也可以取消批次，保留已完成的问题。
4. 每题按 Markdown 展示完整答案，可展开「论文解析正文」对照。部分题目失败时点击「补全六问」；模型单次输出达到接口上限时，自动续写同一题。
5. 再次打开时读取本地结果；完整结果需要点击「重新生成六问」才会重新提交。

相同 PDF 的解析正文按内容哈希复用，文件变化后重新解析。Beta 不设消费上限、答案字数或正文裁剪限制。面板累计显示各题及续写的输入、输出、缓存 tokens，并按带日期的单价快照与 Batch 折扣估算费用；用量缺失时标记未知或费用尚不完整。实际费用以 Kimi 账单为准。

#### Beta 当前已知问题

当前 Batch 解读依赖 Kimi 文件接口返回的文本。实测发现以下内容质量问题，涉及 PDF 文本解析和模型解读：

- **复杂表格可能错位。** 合并单元格、多级表头等结构在解析后可能丢失，模型可能将数值配给错误的方法、列名或指标。
- **正文取材指令尚不能可靠隔离表格。** 即使提示只从正文取材、数值必须在正文中出现，模型仍可能引用仅存在于表格中的数字。当前 Beta 使用完整解析文本。
- **解读完整度与比较结论会波动。** 回答可能遗漏部分实验或附录分析，也可能把作者概括的优势扩大为每项指标都领先。使用具体实验数值、方法比较或结论时，请核对原文对应段落和表格。
- **图像内容取决于文本解析。** 未被解析成文字的图像内容不会自动作为图片发送，图示中的结构和关系可能未被纳入解读。

这些问题尚未在当前 Beta 中解决。`papers.cool` 在线解读和 `Local REL` 本地检索的使用方式保持不变。

### 本地构建与测试

仓库 `main` 对应稳定版；构建 Beta 时请切换到 `v0.1.19-beta.1` 标签。

```bash
npm ci
npm run build
```

构建产物位于 `.scaffold/build/zotero-cool-paper.xpi`。

运行完整测试或仅运行原生侧栏集成测试：

```bash
npm test -- --no-watch
npm test -- --no-watch --integration
```

测试使用 `.scaffold/test` 下的独立资料库，包含测试条目、PDF 和阅读缓存；本地解读测试不调用 Kimi API。

---

## 隐私说明

- `papers.cool` 面板只请求公开的 papers.cool 页面与接口。
- `Local REL` 面板完全在本地运行，不请求 papers.cool，也不会上传 Zotero 条目、标签、摘要或全文。
- papers.cool 缓存保存在本地 SQLite 表 `paperscool_cache`：metadata 与 REL 有效期为 7 天，KIMI 为 30 天；最多保留 500 篇论文和 90 天，可在面板中手动清空。
- 「本地解读」在点击生成、重新生成或补全后，向 `https://api.moonshot.cn/v1` 发送所选 PDF 或解析正文。稳定版使用单次六问请求；Beta 上传包含正文和问题的 Batch 文件，并自动续查任务，必要时续写未完成的题目。上传文件名固定为 `paper.pdf` 和 `questions.jsonl`，不包含附件路径。
- 解析正文保存到本机后尝试删除云端 PDF；Beta 在批次结束并保存结果后，尝试删除对应的输入、输出和错误文件。运行中的批次文件保留供任务使用。删除失败会记录待清理文件，可在面板中重试；上传中断且未返回文件编号时，需通过 Kimi 文件管理检查。
- 本地解析正文、回答、来源、用量和 Beta 批次编号保存在 `pcp_reading_*` 表中，不写入 Zotero 笔记，不通过 Zotero 同步，不自动过期，属于本机数据库备份的一部分。API Key 单独使用 Zotero 密码管理器保存，可从面板移除。开发密钥、论文 PDF 和实验记录不进入插件包。
- 本地解读数据库操作屏蔽调试日志，数据库和 HTTP 错误使用固定提示，避免泄露正文与凭据。

---

## 致谢

- 感谢苏神（苏剑林）做出的伟大 papers.cool 平台，让论文发现、筛选、KIMI 解读和相关论文探索变得优雅又高效
- 感谢 [windingwind/zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit)
- 本项目由 AndyBear 与 OpenAI Codex 协作开发，感谢这段从需求探索到调试打磨的 pair programming （本条由Codex生成）
