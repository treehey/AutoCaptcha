# 发布流程

发布由维护者执行。正式包必须来自 `scripts/build-package.ps1`，不得直接压缩仓库根目录。

## 版本号规则

项目从 `v6.4.0` 起严格采用 [Semantic Versioning](https://semver.org/)，格式固定为 `MAJOR.MINOR.PATCH`。更早的公开版本保留原编号，不删除 Release、不重打标签，也不修改历史版本号。

| 变化类型 | 升级方式 | 例子 |
| --- | --- | --- |
| 只修复既有行为，且不增加用户功能 | `PATCH` | `6.4.0 → 6.4.1` |
| 增加向后兼容的新功能或新交互 | `MINOR` | `6.4.1 → 6.5.0` |
| 引入不兼容变化 | `MAJOR` | `6.x → 7.0.0` |

以下情况通常必须升级 `MAJOR`：

- 旧配置或会话数据无法自动迁移，需要用户重新配置；
- 删除或改变已有核心行为，旧使用方式不再成立；
- 扩大权限、数据用途或信任边界，并因此需要用户重新授权或重新确认；
- 更改支持范围或任务模型，导致现有自动化配置无法保持原语义。

更新内容很多并不自动构成大版本。只要旧配置可迁移、旧操作仍有效且权限边界没有破坏性变化，就继续使用 `MINOR`。`6.10.0` 高于 `6.9.0`，属于正常的语义化版本号。

版本确定后不得为了“看起来更大”临时调整。若同一批改动同时包含新功能和 Bug 修复，按其中最高级别升级：`MAJOR > MINOR > PATCH`。

## 1. 确认范围

- 工作区只包含本次发布相关改动；
- 所有功能变更已有离线检查或明确的人工验收记录；
- 没有真实账号、Cookie、页面快照、原始导出或本地实验输出进入暂存区。

## 2. 更新版本和文档

1. 按上述规则确定版本，并同步更新 `manifest.json` 和 `package.json` 的 `version`。
2. 将 `CHANGELOG.md` 中已完成内容从 `Unreleased` 移到新版本标题，并写入发布日期。
3. 新增 `docs/RELEASE_NOTES_v<version>.md`，并加入 `docs/README.md` 的发布说明索引。
4. 权限、存储或网络行为变化时更新 `PRIVACY.md` 和 `STORE_DESCRIPTION.md`。
5. 用户操作或支持范围变化时更新 `README.md`、使用指南和问题排查文档。
6. README 的版本徽章读取最新 GitHub Release，不手工写死开发版本。

`npm test` 会检查版本格式、两个 JSON 文件的版本一致性、CHANGELOG 当前版本标题、发布说明文件及文档索引。标签和 GitHub Release 尚未创建时无法由 PR 检查验证，发布者必须在推送前人工核对。

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
git tag -a v<version> -m "NJU Login Pro v<version>"
git push origin <branch>
git push origin v<version>
```

在 GitHub Release 中：

- 标题使用 `NJU Login Pro v<version>`；
- 内容以 CHANGELOG 的该版本条目为基础，突出用户可感知变化和升级注意事项；
- 上传 `NJU-Login-Pro-v<version>.zip`；
- 明确提示手动安装用户下载该 ZIP，而不是 GitHub 自动生成的 `Source code`。

推送标签前再次确认版本号和提交对象。标签发布后的修正使用新补丁版本，不移动已公开标签。

GitHub Release 发布后，将 `main` 合并回 `dev`，确保发布文档和版本号不会只停留在主分支。远程仓库长期只保留 `main`、`dev` 和仍在评审的短生命周期分支。

## 6. 商店发布

使用同一个已验收 ZIP 提交 Edge Add-ons，保持商店短描述、权限说明和隐私政策链接一致。商店审核完成后检查公开页面版本和下载行为。
