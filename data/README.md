# 测试与研究数据

`data/` 保存验证码回归样本、标注和本地实验产物。它不属于浏览器扩展正式发布包。

## 目录约定

| 路径 | 用途 | Git 策略 |
| --- | --- | --- |
| `captcha-samples/round-*` | 旧版四位图形验证码样本、答案和联系表 | 规范化回归夹具可跟踪 |
| `click-captcha-samples/round-*` | 选课点击验证码图片、元数据和来源记录 | 规范化回归夹具可跟踪 |
| `click-captcha-exports/` | 浏览器开发工具导出的原始 JSON | 中间产物；新增文件默认忽略 |
| `click-captcha-experiments/` | 模型、缓存、报告和依赖副本 | 本地生成并忽略 |
| `regression-results/` | OCR 回归输出 | 本地生成并忽略 |
| `segmentation-experiments/` | 分割实验输出 | 本地生成并忽略 |
| `recovered-captcha-answers-*` | 临时恢复或修订输出 | 本地生成并忽略 |

历史上已有部分原始导出被跟踪，用于追溯早期导入。忽略规则不会自动删除这些文件；新增数据应优先导入规范化轮次，不继续扩大原始导出集合。

## 点击验证码导入

```powershell
node scripts/import-click-captcha-samples.mjs <export.json> --round <number>
python scripts/verify-click-captcha-target-count.py
```

导入后检查目标轮次的 `metadata.json`、图片数量、点击坐标和目标数。完整规则见 [`docs/CLICK_CAPTCHA_SAMPLING.md`](../docs/CLICK_CAPTCHA_SAMPLING.md)。

## 隐私检查

提交任何新样本前确认不包含：

- 学号、姓名、密码、Cookie、Token 或认证响应；
- 课程表、选课结果或其他可识别个人身份的页面区域；
- 浏览器配置文件路径、机器用户名或未脱敏日志；
- 与验证码评测无关的完整页面源码或网络抓包。

验证码图片本身也可能属于站点生成内容。只保留完成本地回归所需的最小区域，并遵守适用规则。无法确认来源或再分发边界时，不要提交。

## 不可变性和修正

- 已用于报告的原始轮次不原地删除或重写。
- 发现标注错误时，通过修正记录或新轮次保留可追溯性。
- 训练、验证和最终测试划分必须写入对应报告，不能在看到最终测试结果后重新调参并沿用同一“最终测试”名称。
- README 中只引用带完整口径的结果，详细指标记录在 `docs/`。

## 大文件治理

当前数据集是仓库体积的主要来源。首次规范化不重写 Git 历史。未来如迁移到 Git LFS 或独立数据发布包，应单独制定迁移计划，保证历史报告、脚本默认路径和校验哈希仍可追溯。
