#!/usr/bin/env python3
"""扫描项目结构、技术栈、测试资料、入口与依赖清单。

只读脚本：不修改被分析的项目。仅使用 Python 标准库。

用法:
    python scan_project.py <项目路径> [--json] [--max-depth N]

    --json        输出机器可读的 JSON（供智能体进一步推理）
    --max-depth   目录树最大深度（默认 3）
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path

# ---------------------------------------------------------------- 常量定义

DEFAULT_IGNORE_DIRS = {
    ".git", "node_modules", "vendor", "dist", "build", "out", "target",
    "__pycache__", ".venv", "venv", "env", ".next", ".nuxt", "coverage",
    "htmlcov", ".idea", ".vscode", ".mypy_cache", ".pytest_cache",
    ".ruff_cache", ".gradle", ".terraform", "Pods", "DerivedData",
    "obj", "bin", ".tox", ".eggs", "site-packages",
}

# 扩展名 -> 语言
LANG_BY_EXT = {
    ".py": "Python", ".pyi": "Python",
    ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
    ".ts": "TypeScript", ".tsx": "TypeScript",
    ".java": "Java", ".kt": "Kotlin", ".kts": "Kotlin", ".scala": "Scala",
    ".go": "Go", ".rs": "Rust", ".rb": "Ruby", ".php": "PHP",
    ".c": "C", ".h": "C", ".cpp": "C++", ".cc": "C++", ".cxx": "C++", ".hpp": "C++",
    ".cs": "C#", ".swift": "Swift", ".m": "Objective-C", ".mm": "Objective-C++",
    ".sh": "Shell", ".bash": "Shell", ".ps1": "PowerShell",
    ".sql": "SQL", ".vue": "Vue", ".svelte": "Svelte",
    ".html": "HTML", ".css": "CSS", ".scss": "SCSS", ".less": "Less",
    ".json": "JSON", ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML",
    ".xml": "XML", ".md": "Markdown", ".proto": "Protobuf", ".graphql": "GraphQL",
}

# 标志文件 -> 技术栈信号
STACK_MARKERS = [
    ("package.json", "Node.js / JavaScript / TypeScript"),
    ("pnpm-lock.yaml", "pnpm"),
    ("yarn.lock", "Yarn"),
    ("package-lock.json", "npm"),
    ("requirements.txt", "Python"),
    ("pyproject.toml", "Python"),
    ("setup.py", "Python"),
    ("Pipfile", "Python / Pipenv"),
    ("poetry.lock", "Python / Poetry"),
    ("pom.xml", "Java / Maven"),
    ("build.gradle", "Java-Kotlin / Gradle"),
    ("build.gradle.kts", "Kotlin / Gradle"),
    ("go.mod", "Go Modules"),
    ("Cargo.toml", "Rust / Cargo"),
    ("composer.json", "PHP / Composer"),
    ("Gemfile", "Ruby / Bundler"),
    ("CMakeLists.txt", "C-C++ / CMake"),
    ("Makefile", "Make"),
    ("Dockerfile", "Docker"),
    ("docker-compose.yml", "Docker Compose"),
    ("docker-compose.yaml", "Docker Compose"),
    ("Jenkinsfile", "Jenkins CI"),
    (".gitlab-ci.yml", "GitLab CI"),
    ("tsconfig.json", "TypeScript"),
    (".nvmrc", "Node 版本约束"),
    (".python-version", "Python 版本约束"),
]

DIR_MARKERS = [
    (".github/workflows", "GitHub Actions"),
    ("migrations", "数据库迁移"),
    ("alembic", "Alembic 迁移"),
    ("prisma", "Prisma ORM"),
]

TEST_FRAMEWORKS = {
    "jest": ("jest.config.js", "jest.config.ts", "jest.config.cjs"),
    "vitest": ("vitest.config.js", "vitest.config.ts"),
    "pytest": ("pytest.ini", "conftest.py"),
    "unittest": (),
    "junit": (),
    "go-test": (),
    "mocha": (".mocharc.yml", ".mocharc.json"),
}

TEST_DIR_HINTS = {"test", "tests", "__tests__", "spec", "specs", "e2e", "integration"}

ENTRY_NAMES = {
    "main.py", "app.py", "manage.py", "wsgi.py", "asgi.py", "__main__.py", "run.py",
    "index.js", "index.ts", "index.jsx", "index.tsx", "main.js", "main.ts",
    "server.js", "server.ts", "app.js", "app.ts",
    "main.go", "main.rs", "main.cpp", "main.c",
    "Main.java", "Program.cs", "index.php", "app.rb", "main.dart",
}

MAX_LINE_COUNT_BYTES = 5 * 1024 * 1024  # 超过 5MB 的文件跳过行数统计

# ---------------------------------------------------------------- 工具函数


def _utf8_stdout() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass


def count_lines(path: Path) -> int:
    """统计文本文件行数；二进制或超大文件返回 0。"""
    try:
        if path.stat().st_size > MAX_LINE_COUNT_BYTES:
            return 0
        with open(path, "rb") as fh:
            data = fh.read()
        if b"\x00" in data:  # 二进制
            return 0
        if not data:
            return 0
        return data.count(b"\n") + (0 if data.endswith(b"\n") else 1)
    except Exception:
        return 0


def walk_files(root: Path, ignore_dirs: set[str]):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ignore_dirs]
        for name in filenames:
            yield Path(dirpath) / name


def is_test_file(path: Path, root: Path) -> bool:
    rel_parts = set(p.lower() for p in path.relative_to(root).parts[:-1])
    name = path.name.lower()
    if rel_parts & TEST_DIR_HINTS:
        return True
    stem = path.stem.lower()
    if stem.startswith("test_") or stem.startswith("test-"):
        return True
    if "_test" in stem or ".test" in name or ".spec" in name or "_spec" in stem:
        return True
    return False


def read_text(path: Path, limit: int = 200_000) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read(limit)
    except Exception:
        return ""


def read_dependencies(root: Path) -> dict:
    """提取常见依赖清单，仅做轻量解析。"""
    deps: dict = {}

    pkg = root / "package.json"
    if pkg.exists():
        try:
            data = json.loads(read_text(pkg))
            deps["package.json"] = {
                "dependencies": sorted((data.get("dependencies") or {}).keys()),
                "devDependencies": sorted((data.get("devDependencies") or {}).keys()),
                "scripts": data.get("scripts") or {},
                "engines": data.get("engines") or {},
            }
        except Exception:
            deps["package.json"] = {"error": "parse failed"}

    req = root / "requirements.txt"
    if req.exists():
        lines = [
            ln.strip() for ln in read_text(req).splitlines()
            if ln.strip() and not ln.strip().startswith(("#", "-"))
        ]
        deps["requirements.txt"] = lines

    pyproj = root / "pyproject.toml"
    if pyproj.exists():
        try:
            import tomllib  # Python 3.11+
            with open(pyproj, "rb") as fh:
                data = tomllib.load(fh)
            project = data.get("project", {})
            deps["pyproject.toml"] = {
                "name": project.get("name"),
                "dependencies": project.get("dependencies", []),
                "requires-python": project.get("requires-python"),
            }
        except Exception:
            deps["pyproject.toml"] = {"error": "parse failed"}

    gomod = root / "go.mod"
    if gomod.exists():
        text = read_text(gomod)
        mods = []
        in_block = False
        for ln in text.splitlines():
            s = ln.strip()
            if s.startswith("module "):
                deps.setdefault("go.mod", {})["module"] = s.split(None, 1)[1]
            if s.startswith("require ("):
                in_block = True
                continue
            if in_block and s == ")":
                in_block = False
                continue
            if s.startswith("require ") and not s.endswith("("):
                mods.append(s.split(None, 1)[1])
            elif in_block and s:
                mods.append(s.split()[0])
        if mods:
            deps.setdefault("go.mod", {})["require"] = mods

    return deps


def build_tree(root: Path, ignore_dirs: set[str], max_depth: int, max_entries: int = 400) -> list[str]:
    """生成受深度限制的目录树文本行。"""
    lines: list[str] = []
    count = 0

    def recurse(directory: Path, prefix: str, depth: int) -> None:
        nonlocal count
        if depth > max_depth or count > max_entries:
            return
        try:
            entries = sorted(
                [e for e in directory.iterdir() if e.name not in ignore_dirs],
                key=lambda p: (p.is_file(), p.name.lower()),
            )
        except Exception:
            return
        for entry in entries:
            if count > max_entries:
                lines.append(prefix + "... (已截断)")
                return
            if entry.is_dir():
                lines.append(f"{prefix}{entry.name}/")
                count += 1
                recurse(entry, prefix + "    ", depth + 1)
            else:
                if depth <= max_depth:
                    lines.append(f"{prefix}{entry.name}")
                    count += 1

    lines.append(f"{root.name}/")
    recurse(root, "    ", 1)
    return lines


# ---------------------------------------------------------------- 主逻辑


def scan(root: Path, max_depth: int) -> dict:
    files = list(walk_files(root, DEFAULT_IGNORE_DIRS))

    lang_counter: Counter = Counter()
    lang_lines: Counter = Counter()
    ext_counter: Counter = Counter()
    top_dirs: dict = defaultdict(lambda: {"files": 0, "lines": 0})
    test_files: list[str] = []
    entry_files: list[str] = []
    code_files = 0
    total_lines = 0

    for f in files:
        rel = f.relative_to(root)
        ext = f.suffix.lower()
        ext_counter[ext] += 1
        lang = LANG_BY_EXT.get(ext)
        lines = count_lines(f)

        if lang:
            code_files += 1
            total_lines += lines
            lang_counter[lang] += 1
            lang_lines[lang] += lines

        if rel.parts:
            key = rel.parts[0] if len(rel.parts) > 1 else "(root)"
            top_dirs[key]["files"] += 1
            top_dirs[key]["lines"] += lines

        if lang and is_test_file(f, root):
            test_files.append(str(rel).replace("\\", "/"))
        if f.name in ENTRY_NAMES:
            entry_files.append(str(rel).replace("\\", "/"))

    # 技术栈标志
    markers: list[dict] = []
    for name, stack in STACK_MARKERS:
        if (root / name).exists():
            markers.append({"file": name, "stack": stack})
    for name, stack in DIR_MARKERS:
        if (root / name).exists():
            markers.append({"path": name, "stack": stack})

    # 测试框架线索
    frameworks: list[str] = []
    for fw, cfg_files in TEST_FRAMEWORKS.items():
        if any((root / c).exists() for c in cfg_files):
            frameworks.append(fw)
    if test_files and not frameworks:
        if any(p.endswith(".py") for p in test_files):
            frameworks.append("unittest/pytest(推测)")
        if any(p.endswith((".js", ".ts", ".tsx", ".jsx")) for p in test_files):
            frameworks.append("js test runner(推测)")
        if any(p.endswith("_test.go") or p.endswith("test.go") for p in test_files):
            frameworks.append("go test")

    return {
        "root": str(root),
        "summary": {
            "total_files": len(files),
            "code_files": code_files,
            "total_code_lines": total_lines,
            "languages": [
                {"language": k, "files": lang_counter[k],
                 "lines": lang_lines[k], "share": round(lang_counter[k] / code_files, 3) if code_files else 0}
                for k, _ in lang_counter.most_common()
            ],
            "top_extensions": ext_counter.most_common(12),
        },
        "stack_markers": markers,
        "directories": [
            {"name": k, "files": v["files"], "lines": v["lines"]}
            for k, v in sorted(top_dirs.items(), key=lambda kv: -kv[1]["lines"])
        ],
        "tests": {
            "count": len(test_files),
            "frameworks": frameworks,
            "files": sorted(test_files)[:200],
        },
        "entries": sorted(set(entry_files)),
        "dependencies": read_dependencies(root),
        "tree": build_tree(root, DEFAULT_IGNORE_DIRS, max_depth),
    }


def render_markdown(r: dict) -> str:
    out: list[str] = []
    s = r["summary"]
    out.append(f"# 项目扫描：{r['root']}")
    out.append("")
    out.append(f"- 文件总数：{s['total_files']}")
    out.append(f"- 代码文件：{s['code_files']}")
    out.append(f"- 代码总行数：{s['total_code_lines']}")
    out.append("")

    out.append("## 语言分布")
    for item in s["languages"]:
        out.append(f"- {item['language']}：{item['files']} 文件 / {item['lines']} 行")
    out.append("")

    out.append("## 技术栈信号")
    for m in r["stack_markers"]:
        key = m.get("file") or m.get("path")
        out.append(f"- `{key}` → {m['stack']}")
    out.append("")

    out.append("## 顶层目录")
    for d in r["directories"]:
        out.append(f"- {d['name']}：{d['files']} 文件 / {d['lines']} 行")
    out.append("")

    out.append("## 测试现状")
    out.append(f"- 测试文件数：{r['tests']['count']}")
    out.append(f"- 测试框架：{', '.join(r['tests']['frameworks']) or '未识别'}")
    for t in r["tests"]["files"][:30]:
        out.append(f"  - {t}")
    out.append("")

    out.append("## 入口文件")
    for e in r["entries"] or ["(未识别)"]:
        out.append(f"- {e}")
    out.append("")

    out.append("## 依赖清单")
    out.append("```json")
    out.append(json.dumps(r["dependencies"], ensure_ascii=False, indent=2))
    out.append("```")
    out.append("")

    out.append("## 目录树")
    out.append("```")
    out.extend(r["tree"])
    out.append("```")
    return "\n".join(out)


def main() -> int:
    _utf8_stdout()
    parser = argparse.ArgumentParser(description="扫描项目结构、技术栈与测试资料（只读）")
    parser.add_argument("path", help="项目根路径")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    parser.add_argument("--max-depth", type=int, default=3, help="目录树最大深度（默认 3）")
    args = parser.parse_args()

    root = Path(args.path).expanduser().resolve()
    if not root.exists():
        print(f"错误：路径不存在：{root}", file=sys.stderr)
        print("提示：请输入本地文件夹的项目路径（绝对路径优先；压缩包请先解压）。", file=sys.stderr)
        return 2
    if not root.is_dir():
        print(f"错误：路径不是目录：{root}", file=sys.stderr)
        print("提示：请传入项目根目录（文件夹），而非单个文件。", file=sys.stderr)
        return 2

    result = scan(root, args.max_depth)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(render_markdown(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
