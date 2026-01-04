<div align="center">

  <img src="https://github.com/treehey/AutoCaptcha/raw/main/assets/icon128.png" alt="logo" width="100" height="100" />

  # NJU Login Pro
  
  **南京大学统一身份认证 · 自动登录助手**
  
  <br>

  ![Stars](https://img.shields.io/github/stars/treehey/AutoCaptcha?style=flat-square&color=634798&logo=github)
  ![Forks](https://img.shields.io/github/forks/treehey/AutoCaptcha?style=flat-square&color=634798&logo=github)
  ![License](https://img.shields.io/github/license/treehey/AutoCaptcha?style=flat-square&color=634798)
  ![Version](https://img.shields.io/badge/version-2.3.0-634798?style=flat-square)

  <br>

  <p align="center">
    告别手动输入，体验丝滑的毫秒级自动登录。<br>
    专为 NJUer 设计，基于 Chrome 扩展架构与 OCR 技术。
  </p>

</div>

## ✨ 核心特性

| 功能 | 说明 |
| :--- | :--- |
| **🧠 智能识别** | 内置 **Tesseract.js** 引擎，本地精准识别图形验证码，无需联网。 |
| **🛡️ 隐私优先** | 数据仅加密存储于 **浏览器本地 (Chrome Storage)**，绝不上传任何服务器。 |
| **⚡ 毫秒响应** | 页面加载即刻识别，毫秒级填充并自动提交，无需等待。 |
| **🤖 智能填充** | 自动判断浏览器填充状态。支持「强制填充」模式，解决账号冲突。 |
| **🎨 现代交互** | 极简紫韵 UI 面板，支持状态开关、一键配置。 |

<br>

## 🛠️ 安装指南

本插件为非官方扩展，需以“开发者模式”安装。

1.  **下载仓库**：将本 GitHub 仓库克隆或下载到本地：
    ```bash
    git clone [https://github.com/你的用户名/你的仓库名.git](https://github.com/你的用户名/你的仓库名.git)
    ```
    或直接点击 `Code` -> `Download ZIP` 下载。

2.  **解压文件**：如果下载的是 ZIP 文件，请将其解压到一个你容易找到的文件夹。

3.  **打开 Chrome 扩展程序页面**：
    * 在 Chrome 浏览器中，访问 `chrome://extensions`。
    * 或点击浏览器右上角的三个点 -> `更多工具` -> `扩展程序`。

4.  **启用开发者模式**：
    * 在扩展程序页面的右上角，打开 `开发者模式` 开关。

5.  **加载已解压的扩展程序**：
    * 点击左上角的 `加载已解压的扩展程序` 按钮。
    * 选择你之前解压的插件文件夹 (`NJU-Login-Pro-main` 或你克隆的仓库文件夹)。

6.  **固定插件**：
    * 安装成功后，插件会出现在浏览器工具栏的拼图图标中。点击拼图图标，然后点击 `NJU Login Pro` 旁边的**图钉**图标，将其固定在工具栏上，方便快速访问。

## 💡 使用方法

1.  **配置账号信息**：
    * 点击浏览器工具栏上的 `NJU Login Pro` 图标。
    * 在弹出的面板中，输入您的学号/工号和密码。
    * 根据需要开启或关闭“自动登录总开关”和“强制填充账号”选项。
    * 点击“保存配置”按钮。

2.  **自动登录**：
    * 访问南京大学统一身份认证登录页面（例如：`https://authserver.nju.edu.cn/`）。
    * 插件将自动识别验证码、填充账号密码（根据你的设置），并在短暂延迟后自动点击登录按钮。
    * 在识别过程中，页面中央会显示一个“正在识别验证码...”的加载动画。

## ⚙️ 技术栈

* **HTML/CSS/JavaScript**：构建插件界面和核心逻辑。
* **Chrome Extension API**：`chrome.storage` 用于本地数据存储。
* **Tesseract.js**：浏览器端的 OCR 识别库，用于处理验证码图片。

## ⚠️ 注意事项

* 本插件仅为学习交流和个人便利而开发，请勿用于非法用途。
* 数据仅在您的浏览器本地存储，不会上传到任何服务器。但请注意，在公共电脑上使用自动填充功能仍存在安全风险。
* 若南京大学统一身份认证页面结构发生变化，插件可能需要更新以适配新的元素选择器。
* Tesseract.js 识别率受验证码复杂度和清晰度影响，极端情况下可能需要手动输入。

## 🤝 贡献与反馈

欢迎提交 Issue 报告 Bug 或提出功能建议。如果你有兴趣改进代码，也欢迎提交 Pull Request。

## 许可证

本项目采用 MIT 许可证。

<div align="center"> <sub>Made with 💜 by <a href="https://www.google.com/search?q=https://github.com/treehey">Treehey</a></sub> </div>