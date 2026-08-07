# PaddleOCR 离线工具包

私有化发布产物必须在本目录提供以下内容，应用运行时不会联网补齐：

- `runtime/win32-x64/python/python.exe`：内置 Python 与 `requirements.lock` 中的依赖。
- `models/PP-OCRv5_server_det/`：文本检测模型。
- `models/PP-OCRv5_server_rec/`：文本识别模型。
- `models/PP-LCNet_x1_0_textline_ori/`：文本行方向分类模型。
- `runner/run_ocr.py`：统一离线入口。

在有网络的 Windows 构建机执行：

```powershell
$env:PYTHON = "C:\\path\\to\\python.exe"
pnpm --filter @kunqing/desktop paddleocr:prepare
pnpm --filter @kunqing/desktop paddleocr:verify
```

准备脚本会复制独立 Python 运行时、安装锁定依赖并下载三个模型。`package:win` 会强制校验完整性，随后 Electron 通过 `extraResources` 把官方工具资源整体打进安装包。目标机器无需 Python、PaddleOCR 或网络。
