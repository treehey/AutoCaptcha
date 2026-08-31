# 贡献指南

感谢帮助改进 NJU Login Pro。项目处理登录凭证并会执行页面操作，因此正确的权限边界、失败回退和隐私说明与功能本身同样重要。

## 提交前先确认

- 普通 Bug 和功能建议使用对应 Issue 模板。
- 可能泄露凭证、扩大站点权限或绕过用户控制的问题按 [SECURITY.md](SECURITY.md) 私下报告。
- 不要上传真实账号、密码、Cookie、完整页面源码、未脱敏截图或仍含个人信息的样本。
- 大范围架构变更、增加网站、增加权限或引入远程服务应先开 Issue 说明目标和风险。

## 开发流程

1. 从最新目标分支创建短生命周期分支。
2. 阅读[开发环境](docs/development.md)和[架构](docs/architecture.md)。
3. 保持改动聚焦，不把本地实验输出或无关格式化混入提交。
4. 添加或更新相应的离线验证。
5. 运行：

   ```powershell
   npm test
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-package.ps1
   ```

6. 按[测试策略](docs/testing.md)完成与变更风险相称的浏览器人工检查。

## 分支和提交

- 推荐分支前缀：`feat/`、`fix/`、`docs/`、`test/` 或 `chore/`。
- 提交信息使用简短祈使句，可采用 Conventional Commits，例如 `fix: stop retries after manual auth`。
- 每个提交应能独立解释，避免同时包含功能、数据迁移和全仓格式化。
- 不重写他人的公开历史，不移动已发布标签。
- 版本号从 `v6.4.0` 起遵循 SemVer；Bug 修复升 `PATCH`，向后兼容的新功能升 `MINOR`，不兼容变化升 `MAJOR`。完整判定见[发布流程](docs/releasing.md#版本号规则)。

## Pull Request 要求

PR 描述应包括：

- 问题和用户影响；
- 解决方式及未采用方案；
- 权限、隐私、凭证、自动提交或页面点击风险；
- 已运行的自动检查与人工验收；
- UI 变化的脱敏截图；
- 文档和 CHANGELOG 是否需要同步。

评审会特别检查：

- 自动操作是否仍有明确保护条件和停止路径；
- 是否增加远程代码、第三方服务或更宽的网站权限；
- 正式发布白名单是否与 Manifest 一致；
- 回归数据是否被准确描述，是否把开发集误当作未知成功率；
- 新文件是否属于源码、规范化夹具或应被忽略的生成物。

## 文档约定

- 用户入口放在 `README.md`，优先回答安装、上手、隐私和故障处理。
- 详细用户步骤放在 `docs/user-guide.md` 和 `docs/troubleshooting.md`。
- 维护者知识写入架构、开发、测试和发布文档。
- 实验计划和历史结果不得挤占 README 主路径。
- 相对链接必须通过 `npm run verify:repository`。

## 数据和模型

数据目录体积较大，新增前先阅读[data/README.md](data/README.md)。原始浏览器导出是中间产物，不直接提交；规范化样本必须经过隐私检查。模型更新必须保留数据划分、阈值、导出一致性和浏览器回放记录。

项目暂不在普通 PR 中重写 Git 历史或迁移现有大文件。此类治理应单独讨论和执行。
