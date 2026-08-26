<div align="center">

  <img src="assets/icon128.png" alt="NJU Login Pro 图标" width="96" height="96">

  # NJU Login Pro

  **南京大学统一身份认证与选课系统的本地自动登录、验证码处理和课程监控扩展**

  [![Latest release](https://img.shields.io/github/v/release/treehey/AutoCaptcha?style=flat-square&color=634798)](https://github.com/treehey/AutoCaptcha/releases/latest)
  [![License](https://img.shields.io/github/license/treehey/AutoCaptcha?style=flat-square&color=634798)](LICENSE)

  [Edge 商店安装](https://microsoftedge.microsoft.com/addons/detail/hebfkinlcalfnmeeeaciaghoialpmnfp) · [Chrome 手动安装](#chrome-手动安装) · [使用指南](docs/user-guide.md) · [问题排查](docs/troubleshooting.md)

</div>

> [!IMPORTANT]
> 本项目是非官方开源工具，与南京大学无隶属或授权关系。使用者应遵守学校系统规则；页面或验证码变化时，自动化可能失效并回退到人工处理。

## 它能做什么

| 场景 | 行为 | 默认状态 |
| --- | --- | --- |
| 统一身份认证 | 本地定位拼图缺口，完成页面安全验证后填写账号密码并提交 | 开启 |
| 提前准备统一认证 | 浏览器启动后在扩展后台尝试建立一次 SSO 会话，不创建窗口或标签页 | 关闭 |
| 选课系统登录 | 本地匹配中文点击验证码；低置信度时换图，不盲目点击 | 开启 |
| 课程监控 | 按课程关键词检查余量，出现名额时尝试选择并确认 | 手动启动 |

验证码处理使用随扩展打包的 JavaScript、CNN、Tesseract 和 ONNX/WASM 资源，不调用大模型 API、云端打码或第三方分析服务。

## 安装

### Edge 商店安装（推荐）

打开 [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/hebfkinlcalfnmeeeaciaghoialpmnfp)，选择“获取”。商店安装可以自动接收已发布更新。

### Chrome 手动安装

1. 从 [GitHub Releases](https://github.com/treehey/AutoCaptcha/releases/latest) 下载 `NJU-Login-Pro-v*.zip`。不要下载 GitHub 自动生成的 `Source code`。
2. 将 ZIP 解压到固定目录，确认目录根部直接包含 `manifest.json`。
3. 打开 `chrome://extensions`，启用“开发者模式”。
4. 选择“加载已解压的扩展程序”，然后选择刚才的目录。
5. 在浏览器工具栏的扩展菜单中固定 `NJU Login Pro`。

需要从源码调试或自行打包？参阅[开发指南](docs/development.md)。

## 三步开始使用

1. 打开扩展，进入“登录助手”，填写学号或工号与密码并保存。
2. 按需要启用“统一认证自动登录”和“选课系统自动登录”。“提前准备统一认证”默认关闭，只有明确需要启动后预先建立 SSO 会话时再开启。
3. 访问统一认证或选课系统。登录选课系统后，可在“选课监控”中每行填写一个课程关键词并开始监控；建议使用 5 秒或更长的刷新间隔。

完整开关说明、手动识别和更新方式见[使用指南](docs/user-guide.md)。

## 隐私与安全边界

- 账号、密码、课程关键词和开关保存在浏览器的扩展本地存储中。
- 扩展不会为密码额外加密；不要在公共或不受信任的浏览器配置文件中保存凭证。
- 验证码图像在浏览器本地处理，不发送给第三方服务。
- 可选的“提前准备统一认证”由扩展后台直接向 `authserver.nju.edu.cn` 发起正常认证请求。浏览器会正常维护认证 Cookie，但扩展不申请 `cookies` 权限，也不读取 Cookie 值。
- 扩展不包含广告、统计或行为追踪。

完整说明见[隐私政策](PRIVACY.md)。安全问题请不要公开披露凭证、Cookie 或验证码原图，改用[安全报告流程](SECURITY.md)。

## 支持范围

| 网站 | 当前支持 | 失败时的处理 |
| --- | --- | --- |
| `authserver.nju.edu.cn` | 拼图滑块、账号密码填写和提交；兼容旧版四位图形验证码 | 最多尝试有限次数，然后保留官方验证供人工完成 |
| `xk.nju.edu.cn` 登录页 | 四目标中文点击验证码、账号密码填写和提交 | 三目标、背景变化或置信度不足时换图或转人工 |
| `xk.nju.edu.cn` 选课页 | 课程名模糊匹配、余量监控、选择和确认 | 页面结构变化或目标不明确时停止并记录状态 |

历史回归结果用于防止版本退化，不代表未来验证码的成功率承诺。评测口径见[基准与运行结果](docs/benchmarks.md)。

## 常见问题

- **安装后没有反应**：刷新已经打开的南大页面，并确认对应自动登录开关已开启。
- **浏览器提示扩展损坏或无法加载**：确认选择的是解压后的发布包目录，而不是 ZIP、源码压缩包或仓库上级目录。
- **自动登录突然失效**：先人工完成登录并记录页面变化，再按[问题排查指南](docs/troubleshooting.md)提供脱敏信息。
- **想停用或清除数据**：先关闭相关开关；卸载扩展会移除该浏览器配置文件中的扩展本地数据。

## 文档

- [用户使用指南](docs/user-guide.md)
- [常见问题与排查](docs/troubleshooting.md)
- [隐私政策](PRIVACY.md)
- [更新记录](CHANGELOG.md)
- [开发、测试与发布文档](docs/README.md)

## 参与开发

扩展运行时代码不需要编译。安装 Node.js 20 或更高版本后，可以运行全部无账号离线检查：

```powershell
npm test
```

生成正式发布包：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-package.ps1
```

提交问题或 Pull Request 前请阅读[贡献指南](CONTRIBUTING.md)。仓库结构、验证层级和发布流程分别见[架构](docs/architecture.md)、[测试](docs/testing.md)与[发布](docs/releasing.md)文档。

## 许可证

项目源码采用 [MIT License](LICENSE)。随扩展分发的第三方运行时及其许可信息见[第三方软件说明](THIRD_PARTY_NOTICES.md)。

<div align="center"><sub>Made with 💜 by <a href="https://github.com/treehey">Treehey</a></sub></div>
