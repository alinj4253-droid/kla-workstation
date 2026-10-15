"""鲲鹭经营规划智能体 - 启动入口
用法: python run.py [--host 127.0.0.1] [--port 8000]
"""
import os, sys, argparse

# 确保脚本目录在 sys.path 中，支持包导入
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

import uvicorn

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="鲲鹭经营规划智能体服务")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址")
    parser.add_argument("--port", type=int, default=8000, help="监听端口")
    args = parser.parse_args()

    uvicorn.run("api:app", host=args.host, port=args.port, reload=False)
