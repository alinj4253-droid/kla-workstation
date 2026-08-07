import argparse
import json
import os
import sys


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-check", action="store_true")
    parser.add_argument("--image")
    parser.add_argument("--det-model-dir")
    parser.add_argument("--rec-model-dir")
    parser.add_argument("--cls-model-dir")
    return parser.parse_args()


def collect_text(value, lines):
    if isinstance(value, dict):
        for key in ("rec_texts", "text", "texts"):
            item = value.get(key)
            if isinstance(item, str):
                lines.append(item)
            elif isinstance(item, list):
                lines.extend(text for text in item if isinstance(text, str))
        for item in value.values():
            collect_text(item, lines)
    elif isinstance(value, (list, tuple)):
        if len(value) == 2 and isinstance(value[0], str) and isinstance(value[1], (int, float)):
            lines.append(value[0])
        else:
            for item in value:
                collect_text(item, lines)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
    os.environ["HF_HUB_OFFLINE"] = "1"
    args = parse_args()
    from paddleocr import PaddleOCR

    if args.self_check:
        print(json.dumps({"ok": True, "offline": True}, ensure_ascii=False))
        return 0
    if not args.image:
        raise ValueError("--image is required")

    ocr = PaddleOCR(
        text_detection_model_dir=args.det_model_dir,
        text_recognition_model_dir=args.rec_model_dir,
        textline_orientation_model_dir=args.cls_model_dir,
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=True,
    )
    result = ocr.predict(args.image)
    lines = []
    collect_text(result, lines)
    print(json.dumps({"lines": lines, "text": "\n".join(lines)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
