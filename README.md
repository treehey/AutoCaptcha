<div align="center">

  <img src="assets/icon128.png" alt="NJU Login Pro 图标" width="96" height="96">

  # NJU Login Pro

  **南京大学统一身份认证与选课系统的本地自动登录、验证码处理和课程监控扩展**

  [![Edge Add-ons](https://img.shields.io/badge/Edge_商店-获取扩展-0078D7?style=flat-square&logo=microsoftedge&logoColor=white)](https://microsoftedge.microsoft.com/addons/detail/hebfkinlcalfnmeeeaciaghoialpmnfp)
  [![Latest release](https://img.shields.io/github/v/release/treehey/AutoCaptcha?style=flat-square&color=634798)](https://github.com/treehey/AutoCaptcha/releases/latest)
  [![GitHub Stars](https://img.shields.io/github/stars/treehey/AutoCaptcha?style=flat-square&color=634798&logo=github)](https://github.com/treehey/AutoCaptcha/stargazers)
  [![License](https://img.shields.io/github/license/treehey/AutoCaptcha?style=flat-square&color=634798)](LICENSE)

  [快速开始](#三步开始使用) · [使用指南](docs/user-guide.md) · [问题排查](docs/troubleshooting.md) · [隐私政策](PRIVACY.md)

</div>

<br>

> [!IMPORTANT]
> 本项目是非官方开源工具，与南京大学无隶属或授权关系。使用者应遵守学校系统规则；页面或验证码变化时，自动化可能失效并回退到人工处理。

## 核心特性

- <img src="https://api.iconify.design/lucide:zap.svg" width="16" style="vertical-align: text-bottom;"> **无感极速登录**：自动接管统一身份认证与选课系统，验证码识别至表单提交一气呵成。
- <img src="https://api.iconify.design/lucide:target.svg" width="16" style="vertical-align: text-bottom;"> **精准选课监控**：支持教学班精确锁定与关键词模糊匹配，网页右下角全局悬浮窗一键启停。
- <img src="https://api.iconify.design/lucide:brain-circuit.svg" width="16" style="vertical-align: text-bottom;"> **纯本地 AI 识别**：内置轻量级 CNN 与 ONNX 模型，在浏览器内直接完成图形验证码解析，不依赖云端打码，快如闪电。
- <img src="https://api.iconify.design/lucide:shield-check.svg" width="16" style="vertical-align: text-bottom;"> **极致隐私保护**：零行为追踪，密码与配置数据全部在扩展本地存储中端到端处理，安全可控。

<!-- 演示动图将在素材准备完成后补充。 -->

## 安装指南

<details open>
<summary><b>Edge 商店安装（推荐）</b></summary>
<br>

打开 [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/hebfkinlcalfnmeeeaciaghoialpmnfp)，选择“获取”。商店安装可以自动接收最新版本的推送更新。
</details>

<details>
<summary><b>Chrome 手动安装</b></summary>
<br>

1. 从 [GitHub Releases](https://github.com/treehey/AutoCaptcha/releases/latest) 下载 `NJU-Login-Pro-v*.zip`。请注意不要下载 GitHub 自动生成的 `Source code`。
2. 将 ZIP 解压到固定目录，确认目录根部直接包含 `manifest.json` 文件。
3. 打开浏览器的扩展管理页 `chrome://extensions`，开启右上角的“开发者模式”。
4. 点击“加载已解压的扩展程序”，然后选择刚才解压的目录即可。
5. （可选）在浏览器工具栏的扩展菜单中点击图钉固定 `NJU Login Pro`，方便随时唤出面板。
</details>

<br>

需要从源码调试或自行打包？请参阅[开发指南](docs/development.md)。

## 三步开始使用

1. 打开扩展，进入“登录助手”，填写学号或工号与密码并保存。
2. 按需要启用“统一认证自动登录”和“选课系统自动登录”。（“提前准备统一认证”默认关闭，只有明确需要启动后预先建立 SSO 会话时再开启）。
3. 访问统一认证或选课系统。登录选课系统后，优先在目标教学班旁点击“加入监控”；也可在扩展的“选课监控”中手动输入课程关键词。扩展会在选课网页右下角生成全局悬浮窗，点击“开始监控”即可。

完整开关说明、手动识别和更新方式见[使用指南](docs/user-guide.md)。

## 隐私与安全边界

- 账号、密码、课程配置和开关状态均保存在浏览器的扩展本地存储中。
- 运行中的课程监控快照仅保存在 `storage.session` 中，用于同一标签页刷新后恢复；浏览器会话结束后不会作为长期配置保留。
- 扩展不会为密码额外加密，**请不要**在公共或不受信任的浏览器配置文件中保存凭证。
- 验证码图像的推理在浏览器本地完成，绝对不发送给任何第三方打码服务。
- 扩展不包含任何广告、统计或行为追踪代码。

完整说明请阅读[隐私政策](PRIVACY.md)。如发现安全问题，请不要公开披露凭证、Cookie 或验证码原图，请移步[安全报告流程](SECURITY.md)。

## 支持范围

| 网站 | 当前支持 | 失败时的处理机制 |
| --- | --- | --- |
| `authserver.nju.edu.cn` | 拼图滑块、账号密码填写和提交；兼容旧版四位图形验证码 | 最多尝试有限次数，随后保留官方验证供人工完成 |
| `xk.nju.edu.cn` 登录页 | 四目标中文点击验证码、账号密码填写和提交 | 遇到三目标、背景变化或置信度不足时换图或转人工 |
| `xk.nju.edu.cn` 选课页 | 精确教学班或关键词匹配、余量监控、选择、确认和结果验证 | 登录失效时自动保存任务并返回登录页；网络限流时触发自动退避算法 |

> 注：历史回归结果用于防止版本退化，不代表未来验证码的成功率承诺。详细评测口径见[基准与运行结果](docs/benchmarks.md)。

## 常见问题

- **安装后没有反应**：请刷新已经打开的南大页面，并确认扩展内部的自动登录开关处于开启状态。
- **浏览器提示扩展损坏或无法加载**：确认你在“加载已解压的扩展程序”时选择的是解压后的最终目录，而不是 ZIP 文件、源码压缩包或上级目录。
- **自动登录突然失效**：建议先人工完成一次登录并记录页面是否发生变动，再按[问题排查指南](docs/troubleshooting.md)提供脱敏信息。
- **想停用或清除数据**：可以直接在面板中关闭相关开关；或者直接卸载扩展，浏览器会自动移除所有相关的扩展本地数据。

## 文档导航

- [用户使用指南](docs/user-guide.md)
- [常见问题与排查](docs/troubleshooting.md)
- [隐私政策](PRIVACY.md)
- [更新记录](CHANGELOG.md)
- [开发、测试与发布文档](docs/README.md)

## 参与开发

本扩展的运行时代码无需任何编译。只要安装了 Node.js 20 或更高版本，就可以运行全部的无账号离线测试：

```powershell
npm test
```

生成正式发布包：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-package.ps1
```

提交 Issue 或 Pull Request 前请务必阅读[贡献指南](CONTRIBUTING.md)。仓库结构、验证层级和发布流程分别见[架构](docs/architecture.md)、[测试](docs/testing.md)与[发布](docs/releasing.md)文档。

## 许可证

项目源码采用 [MIT License](LICENSE)。随扩展分发的第三方运行时及其许可信息见[第三方软件说明](THIRD_PARTY_NOTICES.md)。

<div align="center"><sub>Made with <img src="https://api.iconify.design/lucide:heart.svg" width="12" style="vertical-align: middle;"> by <a href="https://github.com/treehey">Treehey</a></sub></div>
