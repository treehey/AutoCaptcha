# 测试策略

测试分为仓库静态检查、无账号离线回归、浏览器夹具回放和发布前人工验收。CI 只运行不会接触真实账号或生产认证流程的部分。

## 一键离线检查

```powershell
npm test
```

该命令依次检查：

- 必需文档、JSON 格式、Manifest 版本和本地 Markdown 链接；
- 统一认证快速启动和滑块协议；
- 后台预认证的资格、单次运行、取消、超时和权限保护；
- Popup 帮助和交互约束；
- 验证码开发工具的页面边界；
- 点击验证码采样器和浏览器求解器静态约束。

## 单项命令

| 命令 | 覆盖范围 |
| --- | --- |
| `npm run verify:repository` | 文档、JSON、Manifest 和仓库约定 |
| `npm run verify:auth` | 统一认证快路径、滑块和后台预认证 |
| `npm run verify:popup` | Popup 帮助与交互约束 |
| `npm run verify:click-captcha` | 点击验证码采样与求解保护 |

这些脚本只使用 Node.js 内置模块，不要求安装浏览器驱动或 npm 依赖。

## 点击验证码浏览器回放

启动带正确 MIME 类型的本地夹具服务器：

```powershell
python scripts/serve-click-captcha-fixture.py
```

然后按[点击验证码运行时结果](CLICK_CAPTCHA_RUNTIME_RESULTS.md)中的说明运行浏览器 Worker 回放。不要用未配置 MIME 类型的简单静态服务器替代，否则 `.mjs` 和 WASM 可能在 Windows 上以错误类型返回。

样本目标数检查：

```powershell
python scripts/verify-click-captcha-target-count.py
```

## 旧版图形验证码回归

旧版认证页四位图形验证码使用独立历史样本：

```powershell
node scripts/run-regression.mjs all
```

该命令需要 Playwright。旧页面当前不是生产认证页的主要形态，结果不能代表拼图滑块成功率。

## 发布包检查

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-package.ps1
```

脚本会按白名单构建 `dist/NJU-Login-Pro-v*.zip`、解压检查 Manifest 位于 ZIP 根部、验证关键运行文件和权限，然后清理临时目录。

## 人工验收

涉及页面结构、权限、登录、自动点击或课程监控的变更，在发布前至少验证：

1. 全新浏览器配置文件能安装正式 ZIP；
2. Popup 无账号、已配置、开关关闭和开关开启状态正确；
3. 统一认证页可以人工接管失败流程；
4. 提前准备统一认证默认关闭，且不创建窗口或标签页；
5. 选课点击验证码低置信度时不会盲点；
6. 课程监控能停止，过短或歧义关键词不会静默选择错误目标；
7. 发布包不包含 `data/`、`docs/`、`tests/`、`output/`、源码诊断页面或本地凭证。

真实站点验收不得把账号、密码、Cookie 或包含个人信息的页面保存进 Git。
