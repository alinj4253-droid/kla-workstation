import argparse
import os
import shutil
from pathlib import Path


MODEL_NAMES = (
    "PP-OCRv5_server_det",
    "PP-OCRv5_server_rec",
    "PP-LCNet_x1_0_textline_ori",
)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pack-root", required=True)
    return parser.parse_args()


def cache_roots():
    values = (
        os.environ.get("PADDLE_PDX_CACHE_HOME"),
        os.environ.get("PADDLEX_HOME"),
        str(Path.home() / ".paddlex"),
    )
    roots = []
    for value in values:
        if not value:
            continue
        root = Path(value).expanduser().resolve()
        if root not in roots:
            roots.append(root)
    return roots


def find_model(name, roots):
    matches = []
    for root in roots:
        if not root.exists():
            continue
        direct = root / "official_models" / name
        if direct.is_dir():
            matches.append(direct)
        matches.extend(path for path in root.rglob(name) if path.is_dir() and path != direct)
    if not matches:
        return None
    return max(matches, key=lambda path: sum(1 for item in path.rglob("*") if item.is_file()))


def main():
    args = parse_args()
    pack_root = Path(args.pack_root).resolve()
    roots = cache_roots()
    sources = {name: find_model(name, roots) for name in MODEL_NAMES}
    if any(source is None for source in sources.values()):
        from paddleocr import PaddleOCR

        PaddleOCR(
            text_detection_model_name=MODEL_NAMES[0],
            text_recognition_model_name=MODEL_NAMES[1],
            textline_orientation_model_name=MODEL_NAMES[2],
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=True,
        )
        sources = {name: find_model(name, roots) for name in MODEL_NAMES}

    model_root = pack_root / "models"
    model_root.mkdir(parents=True, exist_ok=True)
    for name in MODEL_NAMES:
        source = sources[name]
        if source is None:
            raise FileNotFoundError(f"Downloaded model directory not found: {name}")
        destination = model_root / name
        shutil.copytree(source, destination, dirs_exist_ok=True)
        if not any(item.is_file() for item in destination.rglob("*")):
            raise RuntimeError(f"Downloaded model directory is empty: {name}")
        print(f"Prepared {name}: {destination}")


if __name__ == "__main__":
    main()
