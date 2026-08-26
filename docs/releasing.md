# 发布流程

发布由维护者执行。正式包必须来自 `scripts/build-package.ps1`，不得直接压缩仓库根目录。

## 1. 确认范围

- 工作区只包含本次发布相关改动；
- 所有功能变更已有离线检查或明确的人工验收记录；
- 没有真实账号、Cookie、页面快照、原始导出或本地实验输出进入暂存区。

## 2. 更新版本和文档

1. 按语义化版本规则同步更新 `manifest.json` 和 `package.json` 的 `version`。
2. 将 `CHANGELOG.md` 中已完成内容从 `Unreleased` 移到新版本标题，并写入发布日期。
3. 权限、存储或网络行为变化时更新 `PRIVACY.md` 和 `STORE_DESCRIPTION.md`。
4. 用户操作或支持范围变化时更新 `README.md`、使用指南和问题排查文档。
5. README 的版本徽章读取最新 GitHub Release，不手工写死开发版本。

## 3. 执行验证

```powershell
npm test
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-package.ps1
```

确认生成的文件名为 `dist/NJU-Login-Pro-v<version>.zip`，并检查：

- ZIP 根部直接包含 `manifest.json`；
- Manifest 版本与计划发布版本一致；
- Popup 是 release 构建，开发专用入口不可见；
- 权限列表没有意外扩大；
- 模型、WASM 和第三方许可说明完整；
- 包中不存在 `data/`、`docs/`、`tests/`、`output/` 或本地配置。

## 4. 人工验收

按[测试策略](testing.md)完成全新浏览器配置文件安装、Popup、统一认证、选课登录和停止监控检查。生产站点验收应使用维护者自己的授权账号，记录结果时必须脱敏。

## 5. 提交、标签和 Release

```powershell
git status --short
git tag v<version>
git push origin <branch>
git push origin v<version>
```

在 GitHub Release 中：

- 标题使用 `NJU Login Pro v<version>`；
- 内容以 CHANGELOG 的该版本条目为基础，突出用户可感知变化和升级注意事项；
- 上传 `NJU-Login-Pro-v<version>.zip`；
- 明确提示手动安装用户下载该 ZIP，而不是 GitHub 自动生成的 `Source code`。

推送标签前再次确认版本号和提交对象。标签发布后的修正使用新补丁版本，不移动已公开标签。

## 6. 商店发布

使用同一个已验收 ZIP 提交 Edge Add-ons，保持商店短描述、权限说明和隐私政策链接一致。商店审核完成后检查公开页面版本和下载行为。
