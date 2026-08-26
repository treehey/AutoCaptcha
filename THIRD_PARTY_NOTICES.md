# 第三方软件说明

NJU Login Pro 的项目源码采用 MIT License。正式扩展包还包含以下第三方运行时和数据文件，它们继续受各自许可证约束。

## Tesseract.js 与 Tesseract 资源

用于旧版四位图形验证码的本地 OCR 回退：

- `tesseract.min.js`
- `langs/worker.min.js`
- `langs/tesseract-core.wasm.js`
- `langs/eng.traineddata`

Tesseract.js、Tesseract.js Core、Tesseract OCR 和官方语言数据以 Apache License 2.0 发布。项目及许可证：

- <https://github.com/naptha/tesseract.js>
- <https://github.com/naptha/tesseract.js-core>
- <https://github.com/tesseract-ocr/tesseract>
- <https://github.com/tesseract-ocr/tessdata>

## ONNX Runtime Web

用于选课点击验证码的本地 WASM 推理：

- `vendor/onnxruntime/ort.wasm.bundle.min.js`
- `vendor/onnxruntime/ort-wasm-simd-threaded.mjs`
- `vendor/onnxruntime/ort-wasm-simd-threaded.wasm`

仓库当前分发 ONNX Runtime Web v1.27.0，采用 MIT License。随附说明见 [`vendor/onnxruntime/NOTICE.md`](vendor/onnxruntime/NOTICE.md)，上游许可证见 <https://github.com/microsoft/onnxruntime/blob/v1.27.0/LICENSE>。

## 项目模型和资源

`assets/` 中的验证码模型及固定背景资源由本项目开发流程生成，随项目 MIT License 分发，除非文件旁另有说明。训练和评测数据的使用边界见 [`data/README.md`](data/README.md)。

## 发布维护要求

- 更新第三方运行时时，应记录上游版本、许可证和来源。
- 不得删除第三方 bundle 中已有的许可证注释。
- 新增第三方运行库、模型或数据前，必须确认其许可证允许随浏览器扩展再分发。
- 发布包白名单或第三方版本变化时，同步更新本文件和相应 `vendor/` 说明。
