# 开发环境

## 前置条件

- Microsoft Edge 或 Google Chrome；
- Node.js 20 或更高版本，用于无依赖的离线验证脚本；
- Windows PowerShell 5.1 或 PowerShell 7，用于发布打包；
- Python 3.11 或更高版本，仅在运行模型评测和训练脚本时需要。

扩展运行时代码不需要转译或打包器。仓库根目录就是开发版扩展目录。

## 开始开发

```powershell
git clone https://github.com/treehey/NJU-Login-Pro.git
Set-Location NJU-Login-Pro
npm test
```

在 `chrome://extensions` 或 `edge://extensions` 中开启开发者模式，选择“加载已解压的扩展程序”，然后选择仓库根目录。修改代码后回到扩展管理页选择“重新加载”，并刷新已打开的目标页面。

源码模式会保留开发诊断入口；正式发布脚本会把 Popup 标记为 release 构建并隐藏开发专用工具。

## 目录职责

| 路径 | 内容 |
| --- | --- |
| 根目录运行文件 | Manifest、Popup、内容脚本和认证后台逻辑 |
| `assets/` | 扩展图标、模型权重和固定预处理资源 |
| `_locales/` | 浏览器商店和 Manifest 本地化文本 |
| `langs/`, `vendor/` | 随扩展分发的第三方 OCR/ONNX 运行时 |
| `scripts/` | 打包、验证、采样、评测和训练脚本 |
| `tests/`, `tools/` | 浏览器夹具和开发工具 |
| `data/` | 已标注回归样本和本地实验输出；规则见 `data/README.md` |
| `docs/` | 用户、维护者、评测和历史发布文档 |

## 验证命令

运行全部无账号离线检查：

```powershell
npm test
```

运行单组检查或生成发布包见[测试策略](testing.md)。

## 可选 Python 分析环境

浏览器扩展的常规修改不需要 Python。只有复现 OCR、点击验证码模型评测或训练时才安装：

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements-analysis.txt
```

PyTorch 的 CPU/CUDA 安装与机器和驱动相关；如需 GPU，应按 PyTorch 对应平台说明替换 requirements 中的安装来源。不要把虚拟环境、模型缓存或训练输出提交到仓库。

## 样本工作流

- 浏览器导出的原始点击验证码 JSON 是导入中间产物，默认不再提交。
- 使用 `node scripts/import-click-captcha-samples.mjs <export.json> --round <number>` 导入规范化轮次。
- 规范化样本和修正记录不得原地重写或删除；新增数据必须先检查账号、Cookie、页面源码和其他个人信息。
- 训练输出、依赖缓存和本地报告放入已忽略的实验目录。

完整约定见[data/README.md](../data/README.md)和[点击验证码采样说明](CLICK_CAPTCHA_SAMPLING.md)。

## 修改原则

- 保持自动提交和自动点击的保护条件可审计。
- 不在代码、测试、截图、Issue 或提交信息中保存真实凭证。
- 不新增远程脚本、远程模型或不必要的网站权限。
- 权限、存储或网络行为变化时，同步更新 `PRIVACY.md`、`README.md`、`STORE_DESCRIPTION.md` 和 `CHANGELOG.md`。
- 保持 Windows PowerShell 打包可用，文本文件使用 UTF-8 和 LF。
