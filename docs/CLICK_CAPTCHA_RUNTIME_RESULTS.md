# 点击验证码浏览器运行时结果

更新日期：2026-07-26

本文记录当前可安装候选的部署实测。所有 `round-001..020` 都已参与过开发或历史检查，不能作为发布结论；发布候选冻结后仍需按工作计划采集 `round-021..030`。

## 当前候选

- 模型：共享 EfficientNet-B0 前五段特征的 5 头本地匹配集成。
- 推理：ONNX Runtime Web WASM Worker，`numThreads = 1`。
- 预处理：固定背景残差、目标字灰度反相、浏览器 Canvas 高质量缩放和七角度旋转。
- 运行策略：分差低于 `0.40` 时，纯标点模式转人工；选课自动登录模式最多换图重试 `5` 次，且要求原图为 `250x120`、顶部候选区相对固定背景的平均 RGB 残差不超过 `12`。选课自动登录默认开启，但可在 Popup 中独立暂停。
- 内容脚本通过同源 Blob 启动模块 Worker，再导入已声明为 Web Accessible Resource 的扩展模块。这避免 Chromium 将内容脚本直接创建 `chrome-extension://` Worker 视为跨源 Worker 而拒绝。

## 可复现结果

| 路径 | 整码准确率 | 平均耗时 | p95 耗时 | 结论 |
| --- | ---: | ---: | ---: | --- |
| PyTorch/ONNX 导出顺序一致性 | 600/600 | ONNX 22.4 ms | - | 通过 |
| Python + 已发布背景 PNG | 590/600 (98.3%) | - | - | 背景量化不是部署差异 |
| 浏览器 Worker + 手写双三次 | 537/600 (89.5%) | 133.8 ms | 153.1 ms | 拒绝，重采样不兼容 |
| 浏览器 Worker + Canvas 高质量缩放 | 587/600 (97.83%) | 95.2 ms | 105.7 ms | 当前候选，含背景兼容计算 |

Canvas 路径的阈值仅在 `round-014..016` 校准：`margin >= 0.40` 接受 `71/90`，其中 `71/71` 正确。冻结的历史 `round-017..020` 上同一阈值接受 `101/120`，其中 `101/101` 正确。全 600 张回放仍有一个高分训练集错例，因此该门槛是风险控制，不是对未知验证码的准确率承诺。

固定背景兼容指标在 600 张的顶部候选区平均残差为 `2.77..8.19`；候选使用宽松门槛 `<= 12`。它仅在页面版本、尺寸或背景与训练环境明显不一致时阻止自动点击，不影响当前 600 张的模型结果。自动点击可在两次点位之间取消；Worker 初始化或同一帧推理失败后会等待验证码变化，避免持续重试消耗资源。

本地夹具的一次冷启动记录为 `340 ms`（Worker、WASM、背景和模型均重新加载）。这是单次观测，不替代正式发布前的冷启动 p95 测量。

## 复现命令

```powershell
python -u scripts/export-click-captcha-ensemble.py --checkpoints data/click-captcha-experiments/expanded-001-013/efficient-seed20260720.pt data/click-captcha-experiments/expanded-001-013/efficient-seed20260721.pt data/click-captcha-experiments/expanded-001-013/efficient-seed20260722.pt data/click-captcha-experiments/expanded-001-013/efficient-seed20260723.pt data/click-captcha-experiments/expanded-001-013/efficient-seed20260724.pt --background-rounds 001-013 --verify-rounds 001-020 --output data/click-captcha-experiments/deploy/click-captcha-ensemble5.onnx --background-output data/click-captcha-experiments/deploy/click-captcha-background.png --report data/click-captcha-experiments/deploy/onnx-parity-ensemble5.json

python -u scripts/evaluate-click-captcha-export.py --checkpoints data/click-captcha-experiments/expanded-001-013/efficient-seed20260720.pt data/click-captcha-experiments/expanded-001-013/efficient-seed20260721.pt data/click-captcha-experiments/expanded-001-013/efficient-seed20260722.pt data/click-captcha-experiments/expanded-001-013/efficient-seed20260723.pt data/click-captcha-experiments/expanded-001-013/efficient-seed20260724.pt --background assets/click-captcha-background.png --rounds 001-020

node scripts/verify-click-captcha-sampler.mjs
node scripts/verify-click-captcha-solver.mjs
powershell -ExecutionPolicy Bypass -File scripts/build-package.ps1
```

浏览器夹具位于 `tests/click-captcha-worker.html`。它必须通过本地 HTTP 服务器访问，以便 Worker、WASM 与模型资源和扩展环境使用同一加载路径。

使用 `python scripts/serve-click-captcha-fixture.py` 启动夹具服务器；不要直接使用未配置 MIME 类型的 `python -m http.server`，否则 Windows 环境可能将 ONNX Runtime 的 `.mjs` 模块以 `text/plain` 返回。

## 包体与后续门槛

- 当前 `v5.2.2` 发布包：`18.49 MiB`（ZIP 文件 `19,391,270` bytes）。
- 旧包约 `12.89 MB`；增量主要来自 ONNX Runtime Web 的 SIMD WASM，模型本体仅约 `1.52 MB`。
- 这个包当前可用，但超过工作计划的 15 MB 目标。不要在发布前临时删除登录 OCR 的依赖；如需减小体积，应单独实现并验证自定义轻量推理器，或验证可兼容的更小运行时。
- `v5.2.0` 后已在真实选课登录页验证扩展派发的点击可被页面接受，并完成“点击验证码 → 填写账号密码 → 提交登录”的流程；页面结构或验证码版本变化时仍需重新验证。
