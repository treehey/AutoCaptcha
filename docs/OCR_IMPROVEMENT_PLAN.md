# OCR 改进计划

目标：把统一身份认证增强验证码的识别稳定性提升到可持续迭代的状态。短期目标是常规样本 `25/30+`，中期目标是混合回归集 `80%+`，同时把热态单次识别耗时稳定压到 `0.5s` 以内。

## 1. 样本与标注

- 每轮采集 30-100 张真实验证码样本。
- 样本放在本地 `data/captcha-samples/`，默认不提交到仓库。
- 每轮生成 `contact-sheet.png` 和 `answers.csv`。
- 用户按编号给出答案，例如：

```text
01: 8qWd
02: c3R9
03: hewX
```

## 2. 基准测试

- 建立一键 OCR 回归脚本，读取样本与答案。
- 输出单轮准确率、平均耗时、P50/P95 耗时。
- 输出错误明细：图片编号、正确值、识别值、候选列表、耗时。
- 按实际验证码规则评分：字母大小写不敏感，数字与字母仍严格区分。
- 保留混淆矩阵，重点追踪 `j/p/i`、`5/S`、`B/D`、`U/t`、`Q/O/0` 等高频混淆。

当前基准结果：

- `round-001` 至 `round-007` 混合回归集：`175/210`，约 `83.3%`，平均 OCR 约 `0.24s`
- 当前混合回归均值已达到 `25/30`；新增困难样本包含更多细笔画、粘连和强干扰线场景，仍是后续优化重点
- 按当前混合回归集估算，平均约 `1.20` 次尝试可识别成功

注意：`round-001` 至 `round-007` 已参与规则调参，只能作为回归集，不能单独证明泛化。新增或修改形态规则后，需要继续采集新的 holdout 样本，避免只记住已有样本。

运行当前样本集：

```powershell
$env:NODE_PATH="$env:TEMP\autocaptcha-pw\node_modules"
node scripts/run-ocr-benchmark.mjs data/captcha-samples/round-001 --verbose
```

当前全量回归：

```powershell
$env:NODE_PATH="$env:TEMP\autocaptcha-pw\node_modules"
node scripts/run-regression.mjs all
```

也可以启动任意静态服务器后，在浏览器打开：

```text
http://127.0.0.1:<port>/tools/ocr-benchmark.html?sample=data/captcha-samples/round-001
```

## 3. 速度优化

- 加 early stop：前两到三路候选一致且置信足够时，不跑 fallback 变体。
- 调整 fallback 策略：只在候选不足、置信低或存在高风险混淆时触发。
- 缓存预处理结果，避免重复计算 mask 和字符形态统计。
- 评估保留 1 worker 与 2 worker 的真实收益，避免初始化和调度开销吃掉并发收益。

## 4. 准确率优化

- 颜色聚类优先：按字符颜色分离主体笔画，降低干扰线权重。
- 字符切分：对 4 个字符区域做更稳定的列投影和连通域分割。
- 轻量模板分类：为高频混淆字符建立模板/形态评分，先做快速判断。
- Tesseract 兜底：只在快路径低置信时跑多变体 OCR。
- 对每轮错误样本追加针对性修正，并用旧样本回归防止倒退。

## 5. 交互优化

- Popup 增加登录助手实时状态：未配置、识别中、已填充、已提交、失败重试。
- 增加选课助手连接检测、最近一轮检测时间、成功课程列表。
- 日志支持清空、复制和状态筛选。
- 减少视觉噪声，统一按钮、状态色和间距。

## 6. 发布质量

- 使用 `scripts/build-package.ps1` 生成干净发布包。
- 发布前检查包内无 `.git`、`dist`、本地样本、临时文件。
- 每次版本更新同步 `manifest.json`、README badge 和 CHANGELOG。
