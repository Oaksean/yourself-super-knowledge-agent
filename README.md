# 随手贴・Suishoutie Desktop

> 本地优先的碎片知识库桌面应用：把公众号文章、GitHub 项目、网页、随手复制的文字，以及 Word / Excel 文件，
> 一键提炼成「标题 + 摘要 + 要点 + 链接 + 分类 + 标签」的知识条目，按分类聚成知识树与思维导图，支持笔记与持续追踪。

所有数据存在本机单个 JSON 文件里，无后端、无数据库、无账号体系；配置大模型是可选项，不配也能离线用。



![知识树](docs/tree.png)



![思维导图](docs/map.png)

> 截图为内置自检使用的样例数据（"滚动测试条目" 等），不含任何真实用户内容。

## 功能



| 模块      | 能力                                                                                         |
| ------- | ------------------------------------------------------------------------------------------ |
| 录入      | 粘贴链接自动识别公众号 / GitHub / 网页；直接粘贴纯文本；导入 Word（.docx）/ Excel（.xlsx）                             |
| 文档导入    | 自带 zip+XML 解析读出正文与内嵌超链接，表格按行展开；大模型给出标题 / 摘要 / 要点 / 标签 / 分类并挑出精选链接；保存时可把文中链接各抓成一条知识（最多 4 条） |
| 摘要      | 配置模型时用模型提炼；未配置时用内置抽取式摘要（数字 / 专名 / 结论句加权，过滤装饰与代码片段，380 字上限 + 5 条要点）                         |
| 相关链接    | 自动抽取官网、GitHub、HuggingFace、魔搭、Gitee、arXiv、B 站等链接并归一化（去 utm、剔图片与静态资源），详情页按平台着色、点击系统浏览器直达     |
| 归档      | 多级分类 + 标签双体系，AI 推荐分类与标签，原始链接始终保留                                                           |
| 视图      | 三视图：列表 / 知识树（分类聚合 + 归类总结）/ 思维导图（根 → 分类 → 条目，贝塞尔连线，可缩放、可滚动）                                 |
| 维护      | 卡片删除、详情页重新抓取（重抓正文 + 重算摘要 + 重抽外链，旧摘要进版本）、只补外链                                               |
| 去重      | 按「来源地址（忽略 utm / 尾斜杠）+ 正文哈希 + 标题近似」判重，保存时提示更新已有；列表标注「疑似重复」并可一键清理                            |
| 检索      | 关键词（标题 / 摘要 / 笔记 / 标签）+ 分类 + 标签 + 星标 / 追踪 / 有更新 组合筛选                                       |
| 笔记 / 追踪 | 笔记自动保存；按条设置 6h/12h/1d/3d/7d 追踪，正文变化时生成新版本                                                  |
| 导出      | 单条 / 当前列表 / 全库 Markdown；全库 JSON 备份与合并导入                                                    |
| 其他      | 剪贴板链接监听（默认关闭）、快捷键、内置自检                                                                     |

## 快速开始

环境：Node.js 18+（建议 20/22），Windows /macOS/ Linux 均可开发。



```
git clone <repo-url> suishoutie-desktop
cd suishoutie-desktop
npm install
npm start
```

国内网络可先设置镜像：



```
npm config set registry https://registry.npmmirror.com
npm config set electron_mirror https://npmmirror.com/mirrors/electron/
```

## 打包（Windows 免安装目录）



```
powershell -ExecutionPolicy Bypass -File scripts\package.ps1
```

产出 `随手贴-Windows/`（含 Electron 运行时与 `resources/app`），整个目录拷走即可运行，双击 `随手贴.exe` 启动。

脚本拒绝覆盖已存在的输出目录，重打包请先改名或删除。

## 内置自检



```
npx electron . --self-test --self-test-out=./output/self-test-result.txt
```

自检会跑逻辑断言 + 真界面渲染 + 离屏截图（结果与 `*-shot.png` / `-tree.png` / `-map.png` 落在 `output/`），

不依赖网络（外链逻辑用本地构造的公众号 HTML 与自造 Office 样件验证）。

## 配置与隐私



* **API Key 不入库**：设置页填写的模型接口、Key、GitHub Token 只写入本机

  `%APPDATA%\随手贴\data\data.json`（macOS/Linux 在对应的 Electron `userData` 目录），

  仓库里没有任何 Key，`.gitignore` 也把 `data/`、`output/`、`*.json` 之类排除。

* **可选模型**：任何 OpenAI 兼容接口，例如火山方舟 `https://ark.cn-beijing.volces.com/api/v3`（模型填 `ep-` 接入点）、

  DeepSeek `https://api.deepseek.com/v1`、OpenAI `https://api.openai.com/v1`。不配置则全部走本地摘要，完全离线。

* **只发正文**：启用模型时发送的只有待摘要的正文文本；抓取时只访问你粘贴的链接；不存在任何遥测上报。

* **数据可迁移**：设置页可打开数据目录、导出 JSON 备份、导入合并。

## 目录结构



```
.
├── main.js                 # 主进程：窗口、IPC、追踪调度、剪贴板监听、菜单
├── preload.js              # 安全桥接（contextIsolation，无 nodeIntegration）
├── core/
│   ├── store.js            # JSON 数据仓库（原子写入 + 备份）
│   ├── fetcher.js          # 公众号 / GitHub(API) / 网页抓取与正文清洗、外链抽取
│   ├── summarize.js        # 大模型摘要 + 本地抽取式摘要 + 文档解析
│   ├── office.js           # .docx / .xlsx 读取（自带 zip 解析，无第三方库）
│   ├── tracker.js          # 更新检测与版本留档
│   └── exporter.js         # Markdown / JSON 导出
├── renderer/               # 无框架 UI（index.html / styles.css / app.js）
├── scripts/
│   ├── selfTest.js         # 内置自检
│   ├── probe.js            # 单链接抓取调试
│   └── package.ps1         # 免安装目录打包
└── package.json
```

## 实现要点



* **抓取**：公众号取 `#js_content` 正文并带 Referer/UA；GitHub 走 API（仓库 README / 单文件 / Issue / Gist），

  失败回退 `raw.githubusercontent.com`；普通网页用 cheerio 清正文。

* **外链四种写法**：`<a href>`、微信隐藏的 `data-link`/`data-url`/`data-href`、正文纯文本网址（含「官网 [xxx.com](https://xxx.com)」这类无协议域名）、文末「阅读原文」。

* **判重**：`sourceKey = hostname(去 www) + pathname(去尾斜杠)` 且忽略 `utm_* / from / spm`，再叠加正文 `contentHash`。

* **文档解析**：`.docx/.xlsx` 即 zip+XML，自写迷你 zip 读取器（EOCD → 中央目录 → 本地头，stored 直取、deflate 用 `zlib.inflateRawSync`）。

* **界面**：无框架、无构建步骤，改完 CSS/JS 直接 Ctrl+R 生效。

## 已知限制



1. 公众号偶发「环境异常 / 需验证」页面，正文取不到，属微信侧风控。

2. 正文靠 JS 动态渲染的站点抓不到，会明确报错而不是给空摘要。

3. 追踪依赖程序运行，关机期间不检查，开机后首次扫描补齐。

4. 单 JSON 存储适合万级条目，再往上建议换 SQLite（`core/store.js` 接口已隔离）。

5. 本地摘要是抽取式的：不编造但也不润色，长文与结构混乱的 README 建议配模型。

6. 外链只认白名单社区与官网类站点，站内导航会被过滤，因此链接数偏少属正常。

7. 文档导入仅支持 `.docx/.xlsx`（`.doc/.xls` 需另存）；Word 图片 / 扫描件 / 文本框内容读不到（不做 OCR）；

   Excel 不计算公式结果；导入时自动抓链接上限 4 条且不递归抓二级链接。

## 贡献

欢迎 Issue / PR。提交前请保证 `npx electron . --self-test` 全绿，并保持无框架、零额外运行时依赖的风格。

## 许可证

[MIT](LICENSE)