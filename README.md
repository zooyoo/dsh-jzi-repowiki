# dsh-plugin-repowiki

[English](#english) | 中文

Qoder 风格的 **Repo Wiki** 插件，用于 DeepSeek Harness（DSH）。

让 agent 扫描你的仓库，规划目录结构并逐页生成带文件引用（`<cite>`）、mermaid 图的中文 Repo Wiki；支持**增量更新**（源码变更后只刷新过期页面）；产出一套与 Qoder `.qoder/repowiki` **同构兼容**的目录与元数据（`content/`、`meta/repowiki-metadata.json`、`knowledge/`），并内置一个 **DSH 侧栏 Wiki 浏览面板**（目录树 + Markdown 渲染 + 引用展示 + 过期标记）。

> 生成环节由 agent + LLM 完成（插件提供结构化工具链），浏览环节由插件自己的 Web 面板完成——两者组合复刻了 Qoder Repo Wiki 的完整体验。

## 功能

| 能力 | 说明 |
|---|---|
| **AI 生成 Wiki** | `repowiki_init` / `repowiki_scan` / `repowiki_write_page` / `repowiki_write_knowledge` 四个工具，引导 agent 完成“骨架 → 扫描快照 → 规划目录 → 逐页生成”的全流程 |
| **GUI 浏览面板** | DSH 侧栏新增 Repo Wiki 入口；支持目录搜索、分层折叠、当前位置提示、本页目录跳转、上一篇/下一篇、折叠引用文件，以及跟随宿主主题的全宽阅读界面 |
| **Qoder 目录同步** | 使用 `wiki_catalogs` 的层级与顺序展示目录；章节概述直接挂到章节标题，保留未登记的磁盘页面 |
| **增量更新** | 每页记录其来源文件的 fs 版本/大小快照；`repowiki_status` 精确报告哪些页面因哪些源文件变更而过期 |
| **Qoder 格式兼容输出** | 生成 `<wikiRoot>/<locale>/content/**/*.md` + `<locale>/meta/repowiki-metadata.json`（wiki_repo/wiki_catalogs/wiki_items/knowledge_relations/wiki_overview 同构字段）+ `knowledge/<locale>/_index.yaml` |

## 安装

插件以 bundle 形式安装进当前 profile。两种方式（任选其一）：

### 方式一：让 agent 装（推荐）

在 DSH 会话里直接说：

> 帮我安装 dsh-plugin-repowiki，仓库地址 https://github.com/WuuShan/dsh-plugin-repowiki

agent 会调用 `plugin_manager` 工具的 `install_bundle` 完成安装（DSH 原生支持 git 地址安装，会先做 `git ls-remote` 连通性检查再走 pnpm）。

### 方式二：CLI 手动装

```bash
dsh plugin --profile desktop install github:WuuShan/dsh-plugin-repowiki
```

安装后立即生效（live profile 无需重启）；若未生效，在 Web 侧边栏 **插件** 页确认 `repowiki` 条目已启用。

## 使用

1. **初始化**：对 agent 说“给这个仓库生成 Repo Wiki”。agent 会依次调用：
   - `repowiki_init` —— 在 `<工作区>/.qoder/repowiki/` 创建骨架（幂等，已有内容会被保留）；
   - `repowiki_scan` —— 扫描源码树并快照（默认排除 `Library/Logs/obj/.svn/.git` 等，可配）；
   - `repowiki_write_page` —— 按规划的目录逐页写入（自动生成 `<cite>` 引用块、维护元数据与索引）；
   - `repowiki_write_knowledge` —— （可选）写入 Qoder 格式知识卡模块。
2. **浏览**：DSH 左侧栏点击 **Repo Wiki** 图标，自动打开目录中的首篇文档。点击章节标题阅读概述，点击左侧箭头独立展开子目录；可搜索页面名称，或使用文末的“上一篇 / 下一篇”按目录顺序阅读。引用文件默认收起，窄面板通过阅读工具栏打开目录。
3. **增量更新**：代码改动后对 agent 说“刷新 Repo Wiki 过期页面”。agent 调 `repowiki_status` 获取过期页面清单，仅重写受影响页面。面板里的“检查更新”按钮也能看到同样的过期标记。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖插件配置：

```yaml
- id: repowiki
  name: dsh-plugin-repowiki
  config:
    wikiRoot: .qoder/repowiki   # Wiki 输出根目录（工作区相对路径）
    locale: zh                  # 内容语言目录名
    overviewPage: 项目概述       # 镜像进 wiki_overview.content 的页面
    excludeDirs: [Library, Logs, obj, .svn, .git]  # 扫描排除
    sourceExts: [.cs, .asmdef, .json, .md]         # 扫描的扩展名
    maxScanFiles: 3000          # 单次扫描文件数上限
```

## 文件布局（与 Qoder 同构）

```
<工作区>/.qoder/repowiki/
├── .repowiki-index.json          ← 本插件的增量索引（源码快照 + 页面→来源映射）
├── zh/
│   ├── content/                  ← Wiki 页面（Qoder 同名目录）
│   │   ├── 项目概述.md
│   │   └── 核心架构/事件驱动架构/事件总线核心.md
│   ├── meta/
│   │   └── repowiki-metadata.json ← wiki_repo / wiki_catalogs / wiki_items /
│   │                               knowledge_relations / wiki_overview / wiki_readme
│   └── (Qoder 原生 content 与本插件共用同一目录，互不覆盖同名文件时共存)
└── knowledge/zh/
    ├── _index.yaml               ← Qoder 知识卡导出索引
    └── <模块名>/_module.yaml + <模块名>.md
```

## 兼容性说明

- `repowiki-metadata.json` 中的 `catalogue_think_content`、`raw_data` 等字段在 Qoder 侧是云端加密内容，本插件生成时留空/省略——**页面文件与目录结构完全兼容**；Qoder 重新生成 Wiki 时会以自己的服务端数据为准，不会破坏本插件的 `content/*.md`。
- 插件 `0.1.6` 以 **DSH `0.2.2-rc.1`** 为适配基线，声明 `engines.dsh: ">=0.2.2-rc.1 <0.3.0"`，并使用 `@deepseek-ai/dsh-tools: "^0.2.2-rc.1"`。该范围用于宿主兼容性检查；其他版本仍需单独验证。
- 浏览已有 Qoder Wiki 时遵循 `wiki_catalogs.parent_id`、`order` 与 `wiki_items.catalog_id`；`order` 缺省或为 `null` 时按首项处理。目录内同名概述页合并为章节入口，磁盘实际路径保持不变；缺少元数据时回退到文件目录，不隐藏未登记的页面。
- 文件解析按目标宿主接口将取消信号放入 `ctx.fs.resolve(path, { cwd, signal })`；写入继续经过宿主的 `fs/write-intent` 和当前会话的沙箱策略。
- 面板数据通过宿主 `webServer` 的同源路由 `/plugins/dsh-plugin-repowiki/api/*` 提供（只读）。路由与可选服务的注入作用域绑定，服务卸载时撤销，注册中途失败时回滚；没有 Web 服务时仍可使用 Wiki 工具。

## 性能与缓存

- 阅读正文使用可用宽度，长表格和代码块在各自区域内横向滚动；正文段落样式不覆盖 SVG 内部标签的行高和间距，避免 Mermaid 多行文字被裁切。
- 会话消息更新不会触发正文重新解析；目录和搜索的更新与 Markdown 渲染隔离。最近的 3 篇已渲染页面保留 DOM，减少返回页面时的正文和图表重复生成。阅读滚动区与当前页的 Mermaid SVG 分别合成，减少复杂图表随滚动重复绘制。
- 页面数据最多缓存 12 篇、共约 2 Mi 字符，按工作区隔离；切换时先显示已有内容，同时重新读取正文核验变更。空闲时预读相邻页面；点击时重新发起读取，较早的预读响应不能覆盖本次结果。同页重验保留滚动位置；手动刷新、切换工作区或卸载面板时清理缓存并取消未完成的请求。
- 浏览 API 复用目录树和解析后的元数据，按文件版本和目录变更失效，最多保留 8 个工作区快照；正文请求仍读取实际文件。手动刷新强制重建快照，不依赖过期时间掩盖文件变化。
- 性能验证区分服务端耗时、首次正文显示、热切页、交互后绘制和首次图表生成。100 ms 是交互优化目标；首次加载宿主模块、复杂 Markdown 和外部图表增强器的首次渲染需单独测量，不能由 API 耗时推导。

## 开发

两个入口均无需构建：`lib/index.js` 是 Node ESM 宿主插件，`lib/client.js` 是通过 `window.__ModuleLoader__.load` 加载的浏览器模块。

从源码安装开发依赖后执行检查和打包（Windows 使用 PowerShell 7）：

```powershell
$ErrorActionPreference = 'Stop'
npm install --ignore-scripts
npm --script-shell=pwsh run check
npm --script-shell=pwsh test
npm pack --ignore-scripts
```

`npm test` 在当前进程运行 Node 测试，兼容禁止子进程管道的 Windows 沙箱。回归覆盖初始化、扫描、页面和知识卡写入、浏览 API、Qoder 目录排序与层级、取消信号、路由卸载/重新注入及注册失败回滚；文件服务、沙箱策略和服务生命周期使用测试适配器，不代表完整桌面宿主或浏览器端到端验收。

`test/browser-ui.mjs` 提供可选的浏览器验证，需要本地 DSH Web GUI 和已开启 CDP 的 Chromium。它在独立页面加载宿主真实 React、MarkdownText 与主题样式，检查目录、搜索、阅读、本页目录、键盘焦点及明暗主题；工作区服务使用适配器，支持只读已有 Wiki，属于组件与路由集成验证，不等同于完整桌面会话验收。

`test/browser-performance.mjs` 在同一环境测量真实 Wiki 的正文显示、切页、目录、搜索、会话更新和滚动帧间隔，并记录模块源码指纹。图表验证需显式加载本机已安装的 `dsh-mermaid` 增强器及其公开运行时；没有图表时标为未测，不以代码块渲染代替图表通过。可通过 `REPOWIKI_CLIENT`、`REPOWIKI_BACKEND` 指定基线源码，通过 `REPOWIKI_PERF_LABEL` 分开保存报告。

生成的 `dsh-plugin-repowiki-0.1.6.tgz` 可通过 DSH 插件管理安装；发布包只包含运行入口、Cordis 补丁、说明和许可证，测试文件与本地验证依赖不打入包。

## License

MIT
