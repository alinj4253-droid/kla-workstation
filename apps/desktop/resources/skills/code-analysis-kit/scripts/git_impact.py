#!/usr/bin/env python3
"""分析 Git 变更的影响面：变更文件、按模块聚合、反向依赖候选。

只读脚本：不修改被分析的项目。仅使用 Python 标准库。
无 Git 时可用 --compare 比较两份代码快照目录。

用法:
    python git_impact.py <项目路径> [--range <git范围>] [--json]
    python git_impact.py <旧快照> --compare <新快照> [--json]

    --range     Git 范围，如 HEAD、HEAD~1、main..feature、<sha>（默认工作区改动）
    --compare   与另一份快照目录做文件级比较（无 Git 场景）
    --json      输出 JSON
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

DEFAULT_IGNORE_DIRS = {
    ".git", "node_modules", "vendor", "dist", "build", "out", "target",
    "__pycache__", ".venv", "venv", "env", ".next", ".nuxt", "coverage",
    ".idea", ".vscode", ".mypy_cache", ".pytest_cache", ".ruff_cache",
    ".gradle", ".terraform", "obj", "bin",
}

CODE_EXTS = {
    ".py", ".pyi", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx",
    ".java", ".kt", ".kts", ".scala", ".go", ".rs", ".rb", ".php",
    ".c", ".h", ".cpp", ".cc", ".hpp", ".cs", ".swift", ".m", ".mm",
    ".sh", ".bash", ".ps1", ".sql", ".vue", ".svelte", ".dart",
}

REF_KEYWORD = re.compile(r"\b(import|require|from|include|use|use\s+crate)\b", re.IGNORECASE)

STATUS_NAME = {
    "A": "added", "M": "modified", "D": "deleted", "R": "renamed",
    "C": "copied", "T": "typechange", "U": "unmerged",
}


def _utf8_stdout() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass


def run_git(path: Path, args: list[str]) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            ["git", "-C", str(path), *args],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        return proc.returncode, proc.stdout or "", proc.stderr or ""
    except FileNotFoundError:
        return 127, "", "git 未安装或不在 PATH 中"
    except Exception as exc:  # pragma: no cover
        return 1, "", str(exc)


# ---------------------------------------------------------------- Git 解析


def resolve_range(path: Path, rng: str | None) -> tuple[str | None, str, list[str]]:
    notes: list[str] = []
    if rng:
        return rng, "user", notes

    rc, out, _ = run_git(path, ["diff", "HEAD", "--name-status"])
    if rc == 0 and out.strip():
        return "HEAD", "worktree", notes

    rc, out, _ = run_git(path, ["rev-parse", "--verify", "HEAD~1"])
    if rc == 0:
        rc2, out2, _ = run_git(path, ["diff", "HEAD~1", "HEAD", "--name-status"])
        if rc2 == 0 and out2.strip():
            notes.append("工作区无改动，回退到最近一次提交（HEAD~1..HEAD）")
            return "HEAD~1 HEAD", "last-commit", notes

    notes.append("未检测到任何变更（工作区干净且无可用历史对比）")
    return None, "none", notes


def parse_name_status(out: str) -> list[dict]:
    changes = []
    for line in out.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        status = parts[0].strip()
        code = status[0] if status else "?"
        if code in ("R", "C") and len(parts) >= 3:
            changes.append({"status": code, "path": parts[2], "old_path": parts[1]})
        elif len(parts) >= 2:
            changes.append({"status": code, "path": parts[1], "old_path": None})
    return changes


def parse_numstat(out: str) -> dict[str, tuple[int, int]]:
    result: dict[str, tuple[int, int]] = {}
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        ins, dele, path = parts[0], parts[1], parts[2]
        try:
            result[path] = (int(ins), int(dele))
        except ValueError:
            result[path] = (0, 0)
    return result


def collect_source_files(root: Path) -> list[Path]:
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in DEFAULT_IGNORE_DIRS]
        for name in filenames:
            p = Path(dirpath) / name
            if p.suffix.lower() in CODE_EXTS:
                files.append(p)
    return files


def find_reverse_deps(root: Path, changed_paths: list[str]) -> list[dict]:
    """在被改文件之外，查找引用了被改模块（按文件名 stem）的源码文件。"""
    stems: dict[str, str] = {}
    for p in changed_paths:
        stem = Path(p).stem
        if stem and stem not in ("__init__", "index", "main"):
            stems.setdefault(stem, p)

    if not stems:
        return []

    patterns = {s: re.compile(r"\b" + re.escape(s) + r"\b") for s in stems}
    hits: dict[str, set[str]] = defaultdict(set)
    changed_set = set(changed_paths)

    for src in collect_source_files(root):
        try:
            rel = src.relative_to(root).as_posix()
        except ValueError:
            rel = src.as_posix()
        if rel in changed_set:
            continue
        try:
            text = src.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            if not REF_KEYWORD.search(line):
                continue
            for stem, pat in patterns.items():
                if pat.search(line):
                    hits[stems[stem]].add(f"{rel}:{lineno}")

    return [
        {"changed": changed, "referenced_by": sorted(refs)[:40]}
        for changed, refs in hits.items()
    ]


# ---------------------------------------------------------------- 快照比较


def hash_file(path: Path) -> str:
    h = hashlib.sha1()
    try:
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(65536), b""):
                h.update(chunk)
    except Exception:
        return ""
    return h.hexdigest()


def compare_dirs(old: Path, new: Path) -> dict:
    def snapshot(root: Path) -> dict[str, str]:
        snap: dict[str, str] = {}
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in DEFAULT_IGNORE_DIRS]
            for name in filenames:
                p = Path(dirpath) / name
                snap[p.relative_to(root).as_posix()] = hash_file(p)
        return snap

    old_snap, new_snap = snapshot(old), snapshot(new)
    changes = []
    for path, h in new_snap.items():
        if path not in old_snap:
            changes.append({"status": "A", "path": path, "old_path": None, "insertions": None, "deletions": None})
        elif old_snap[path] != h:
            changes.append({"status": "M", "path": path, "old_path": None, "insertions": None, "deletions": None})
    for path in old_snap:
        if path not in new_snap:
            changes.append({"status": "D", "path": path, "old_path": None, "insertions": None, "deletions": None})
    return {"changes": changes, "numstat": {}, "notes": [f"快照比较：{old} → {new}"]}


# ---------------------------------------------------------------- 汇总与输出


def module_of(path: str) -> str:
    parts = Path(path).parts
    if len(parts) > 1:
        return parts[0]
    return "(root)"


def build_result(root: Path, changes: list[dict], numstat: dict, range_: str | None,
                 source: str, notes: list[str]) -> dict:
    for c in changes:
        ins, dele = numstat.get(c["path"], (None, None))
        c["insertions"], c["deletions"] = ins, dele
        c["module"] = module_of(c["path"])

    status_counter: dict[str, int] = defaultdict(int)
    module_agg: dict[str, dict] = defaultdict(lambda: {"files": 0, "insertions": 0, "deletions": 0})
    total_ins = total_del = 0
    for c in changes:
        status_counter[STATUS_NAME.get(c["status"], c["status"])] += 1
        m = module_agg[c["module"]]
        m["files"] += 1
        if c.get("insertions"):
            m["insertions"] += c["insertions"]
            total_ins += c["insertions"]
        if c.get("deletions"):
            m["deletions"] += c["deletions"]
            total_del += c["deletions"]

    changed_code = [c["path"] for c in changes
                    if c["status"] != "D" and Path(c["path"]).suffix.lower() in CODE_EXTS]
    reverse = find_reverse_deps(root, changed_code) if root.is_dir() else []

    return {
        "root": str(root),
        "range": range_,
        "range_source": source,
        "summary": {
            "files_changed": len(changes),
            "by_status": dict(status_counter),
            "insertions": total_ins,
            "deletions": total_del,
        },
        "changes": changes,
        "by_module": [
            {"module": k, **v} for k, v in sorted(module_agg.items(), key=lambda kv: -kv[1]["files"])
        ],
        "reverse_deps": reverse,
        "notes": notes,
    }


def render_markdown(r: dict) -> str:
    out: list[str] = []
    s = r["summary"]
    out.append(f"# 变更影响分析：{r['root']}")
    out.append("")
    snapshot = r["range_source"] == "snapshot"
    range_disp = r["range"] if r["range"] else ("快照比较" if snapshot else "无变更")
    out.append(f"- 比较范围：{range_disp}（来源：{r['range_source']}）")
    out.append(f"- 变更文件：{s['files_changed']}（" +
               "、".join(f"{k} {v}" for k, v in s["by_status"].items()) + "）")
    if not snapshot:
        out.append(f"- 代码增减：+{s['insertions']} / -{s['deletions']}")
    for n in r["notes"]:
        out.append(f"- 备注：{n}")
    out.append("")

    out.append("## 变更文件")
    for c in r["changes"]:
        ins = "" if c.get("insertions") is None else f"  (+{c['insertions']}/-{c['deletions']})"
        old = f" ← {c['old_path']}" if c.get("old_path") else ""
        out.append(f"- [{c['status']}] {c['path']}{old}{ins}")
    out.append("")

    out.append("## 按模块聚合")
    for m in r["by_module"]:
        if snapshot:
            out.append(f"- {m['module']}：{m['files']} 文件")
        else:
            out.append(f"- {m['module']}：{m['files']} 文件  (+{m['insertions']}/-{m['deletions']})")
    out.append("")

    out.append("## 反向依赖候选（引用了被改模块的位置）")
    if not r["reverse_deps"]:
        out.append("- 未发现（或变更文件非源码 / 项目未建立引用关系）")
    for item in r["reverse_deps"]:
        out.append(f"- `{item['changed']}` ← {len(item['referenced_by'])} 处引用")
        for ref in item["referenced_by"][:15]:
            out.append(f"    - {ref}")
    return "\n".join(out)


def main() -> int:
    _utf8_stdout()
    parser = argparse.ArgumentParser(description="分析 Git 变更影响面（只读）")
    parser.add_argument("path", help="项目根路径（或旧快照路径，配合 --compare）")
    parser.add_argument("--range", dest="range_", default=None, help="Git 范围，如 HEAD~1、main..feature")
    parser.add_argument("--compare", default=None, metavar="NEW_SNAPSHOT", help="与另一份快照目录比较")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    args = parser.parse_args()

    root = Path(args.path).expanduser().resolve()
    if not root.exists():
        print(f"错误：路径不存在：{root}", file=sys.stderr)
        print("提示：请输入本地文件夹的项目路径（绝对路径优先）。", file=sys.stderr)
        return 2

    if args.compare:
        new_root = Path(args.compare).expanduser().resolve()
        if not new_root.is_dir():
            print(f"错误：比较目录不存在或不是目录：{new_root}", file=sys.stderr)
            print("提示：--compare 需要传入另一份本地快照文件夹路径。", file=sys.stderr)
            return 2
        cmp_data = compare_dirs(root, new_root)
        result = build_result(new_root, cmp_data["changes"], cmp_data["numstat"], None, "snapshot", cmp_data["notes"])
    else:
        if not root.is_dir():
            print("错误：项目路径不是目录", file=sys.stderr)
            print("提示：请传入本地项目根目录（文件夹）；如需比较快照，请使用 --compare。", file=sys.stderr)
            return 2
        rc, out, err = run_git(root, ["rev-parse", "--is-inside-work-tree"])
        if rc != 0 or out.strip() != "true":
            print("错误：目标不是 Git 仓库。无 Git 时请使用 --compare 比较两份快照目录。", file=sys.stderr)
            if err.strip():
                print(f"git: {err.strip()}", file=sys.stderr)
            return 3

        range_, source, notes = resolve_range(root, args.range_)
        if range_ is None:
            result = build_result(root, [], {}, None, source, notes)
        else:
            _, ns_out, _ = run_git(root, ["diff", "--name-status", *range_.split()])
            _, num_out, _ = run_git(root, ["diff", "--numstat", *range_.split()])
            changes = parse_name_status(ns_out)
            numstat = parse_numstat(num_out)

            # git diff 不含未跟踪的新文件，单独补充（否则会漏掉新增文件的影响面）
            if source == "worktree":
                _, others_out, _ = run_git(root, ["ls-files", "--others", "--exclude-standard"])
                seen = {c["path"] for c in changes}
                untracked = [ln.strip() for ln in others_out.splitlines() if ln.strip()]
                for p in untracked:
                    if p not in seen:
                        changes.append({"status": "A", "path": p, "old_path": None})
                if untracked:
                    notes.append(f"含 {len(untracked)} 个未跟踪的新增文件")

            result = build_result(root, changes, numstat, range_, source, notes)

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(render_markdown(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
