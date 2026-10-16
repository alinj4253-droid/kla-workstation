#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""图片预处理：裁掉右下角工具水印；可选把图切成 N 条横带。

用法（必须用带 Pillow 的 venv 解释器）：
  PY="C:/Users/Administrator/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
  "$PY" prep_images.py --dir assets --crop-watermark
  "$PY" prep_images.py --dir assets --slice 3 --only "three_lives.png"

参数：
  --dir             目标目录（必填）
  --crop-watermark  裁掉右下角水印区域（宽 ×0.885、高 ×0.918），原地覆盖
  --slice N         把每张图纵向切成 N 条等宽横带，输出 <name>_1.png .. <name>_N.png
  --only PATTERN    文件名通配，默认 *.png
"""
import argparse
import glob
import os
import sys

try:
    from PIL import Image
except ImportError:
    print("缺少 Pillow。请使用带 Pillow 的 venv 解释器：", file=sys.stderr)
    print("  C:/Users/Administrator/.workbuddy/binaries/python/envs/default/Scripts/python.exe",
          file=sys.stderr)
    sys.exit(2)

# ImageGen 产物的工具水印位置（右下角），按比例裁剪
WM_RATIO_W = 0.885
WM_RATIO_H = 0.918


def crop_watermark(path):
    """裁掉右下角水印，原地覆盖。返回 (原尺寸, 新尺寸)。"""
    im = Image.open(path)
    w, h = im.size
    trimmed = im.crop((0, 0, int(w * WM_RATIO_W), int(h * WM_RATIO_H)))
    trimmed.save(path, "PNG")
    return (w, h), trimmed.size


def slice_bands(path, n):
    """把图纵向切成 n 条等高横带。返回 [(输出文件, 尺寸), ...]。"""
    im = Image.open(path)
    w, h = im.size
    band = h // n
    stem = os.path.splitext(path)[0]
    results = []
    for i in range(n):
        top = i * band
        out = "%s_%d.png" % (stem, i + 1)
        im.crop((0, top, w, top + band)).save(out, "PNG")
        results.append((out, (w, band)))
    return results


def main():
    ap = argparse.ArgumentParser(description="ImageGen 素材预处理")
    ap.add_argument("--dir", required=True, help="目标目录")
    ap.add_argument("--crop-watermark", action="store_true", help="裁掉右下角水印")
    ap.add_argument("--slice", type=int, default=0, help="纵向切成 N 条横带")
    ap.add_argument("--only", default="*.png", help="文件名通配，默认 *.png")
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.dir, args.only)))
    # 不处理上次切带产生的 _1/_2... 片段
    files = [f for f in files if not any(
        os.path.splitext(os.path.basename(f))[0].endswith("_%d" % i) for i in range(1, 10))]

    if not files:
        print("没有匹配到文件：%s/%s" % (args.dir, args.only))
        return 1

    for f in files:
        name = os.path.basename(f)
        if args.crop_watermark:
            old, new = crop_watermark(f)
            print("crop  %-28s %sx%s -> %sx%s" % (name, old[0], old[1], new[0], new[1]))
        if args.slice and args.slice > 1:
            for out, size in slice_bands(f, args.slice):
                print("slice %-28s -> %sx%s" % (os.path.basename(out), size[0], size[1]))

    print("完成，共处理 %d 个文件。" % len(files))
    return 0


if __name__ == "__main__":
    sys.exit(main())
