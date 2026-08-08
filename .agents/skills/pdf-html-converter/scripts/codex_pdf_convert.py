#!/usr/bin/env python3
"""Render MEW PDF pages and optionally dispatch one Codex CLI run per page group."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


def workspace_override_from_argv() -> str | None:
    """Read --workspace early because workspace modules load before argparse runs."""
    for index, value in enumerate(sys.argv[1:]):
        if value == "--workspace" and index + 2 <= len(sys.argv[1:]):
            return sys.argv[index + 2]
        if value.startswith("--workspace="):
            return value.split("=", 1)[1]
    return None


def is_workspace(candidate: Path) -> bool:
    return all(
        (
            (candidate / "MEWbrief.py").is_file(),
            (candidate / "unpackpdf.py").is_file(),
            (candidate / "prompts").is_dir(),
        )
    )


def find_workspace() -> Path:
    explicit = workspace_override_from_argv() or os.environ.get("MEW_PDF_WORKSPACE")
    if explicit:
        candidate = Path(explicit).expanduser().resolve()
        if not is_workspace(candidate):
            raise RuntimeError(
                f"工作区无效：{candidate}；应包含 MEWbrief.py、unpackpdf.py 和 prompts/"
            )
        return candidate

    starts = [Path.cwd().resolve(), Path(__file__).resolve().parent]
    seen: set[Path] = set()
    for start in starts:
        for candidate in (start, *start.parents):
            if candidate in seen:
                continue
            seen.add(candidate)
            if is_workspace(candidate):
                return candidate
    raise RuntimeError(
        "找不到工作区。请传入 --workspace <目录>，或设置 MEW_PDF_WORKSPACE；"
        "该目录应包含 MEWbrief.py、unpackpdf.py 和 prompts/。"
    )


WORKSPACE = find_workspace()
DEFAULT_CODEX_MODEL = "gpt-5.6-luna"


def load_workspace_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载模块：{path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MEWBRIEF = load_workspace_module("codex_pdf_mewbrief", WORKSPACE / "MEWbrief.py")
UNPACKPDF = load_workspace_module("codex_pdf_unpackpdf", WORKSPACE / "unpackpdf.py")


def parse_pages(value: str) -> list[int]:
    pages: set[int] = set()
    for raw_part in value.split(","):
        part = raw_part.strip()
        if not part:
            continue
        match = re.fullmatch(r"(\d+)\s*-\s*(\d+)", part)
        if match:
            first, last = map(int, match.groups())
            if first > last:
                raise argparse.ArgumentTypeError(f"页码范围倒置：{part}")
            pages.update(range(first, last + 1))
        elif part.isdigit():
            pages.add(int(part))
        else:
            raise argparse.ArgumentTypeError(f"无法解析页码：{part}")
    if not pages or min(pages) < 1:
        raise argparse.ArgumentTypeError("页码必须是从 1 开始的正整数")
    return sorted(pages)


def page_groups(vol: int) -> list[list[int]]:
    try:
        raw_groups = MEWBRIEF.page_group[vol]
    except (IndexError, TypeError) as exc:
        raise ValueError(f"卷号超出 MEWbrief.page_group 范围：{vol}") from exc
    if not raw_groups:
        raise ValueError(f"MEWbrief.py 中没有第 {vol} 卷的页码组")
    return [list(group) for group in raw_groups if isinstance(group, (list, tuple)) and group]


def make_plan(vol: int, pages: list[int]) -> dict:
    requested = set(pages)
    known = page_groups(vol)
    touched: list[dict] = []
    covered: set[int] = set()
    for group in known:
        overlap = sorted(requested.intersection(group))
        if not overlap:
            continue
        covered.update(overlap)
        touched.append(
            {
                "known_group": group,
                "selected_pages": overlap,
                "complete": overlap == group,
            }
        )
    return {
        "volume": vol,
        "requested_pages": pages,
        "groups": touched,
        "partial_groups": [item for item in touched if not item["complete"]],
        "unknown_pages": sorted(requested - covered),
    }


def default_pdf(vol: int) -> Path:
    if vol in (261, 262, 263):
        return WORKSPACE / "马恩全集德文" / f"mew_band26_{vol - 260}.pdf"
    return WORKSPACE / "马恩全集德文" / f"mew_band{vol:02d}.pdf"


def default_cache(vol: int) -> Path:
    return WORKSPACE / (f"cache_images26_{vol - 260}" if vol in (261, 262, 263) else f"cache_images{vol}")


def default_output(vol: int) -> Path:
    return WORKSPACE / "MEW_BRIEF" / str(vol)


def output_name(vol: int, first_page: int) -> str:
    if vol in (261, 262, 263):
        return f"ME26-{vol - 260}{first_page:03d}.html"
    return f"ME{vol:02d}-{first_page:03d}.html"


def resolve_paths(args: argparse.Namespace) -> tuple[Path, Path, Path]:
    def resolve_override(value: str | None, fallback: Path) -> Path:
        if not value:
            return fallback.resolve()
        path = Path(value).expanduser()
        if not path.is_absolute():
            path = WORKSPACE / path
        return path.resolve()

    pdf = resolve_override(args.pdf, default_pdf(args.vol))
    cache = resolve_override(args.cache_dir, default_cache(args.vol))
    output = resolve_override(args.output_dir, default_output(args.vol))
    return pdf, cache, output


def render_pages(pdf: Path, cache_dir: Path, dpi: int, pages: list[int]) -> list[Path]:
    if not pdf.is_file():
        raise FileNotFoundError(f"PDF 文件不存在：{pdf}")
    cache = UNPACKPDF.ImageCache(pdf, cache_dir, dpi=dpi, auto_preprocess=False)
    return [Path(cache.get_image_path(page)).resolve() for page in pages]


def prompt_path(vol: int) -> Path:
    name = "convert23.md" if vol in range(23, 26) else "convert2.md"
    return WORKSPACE / "prompts" / name


def build_prompt(vol: int, pages: list[int], instruction: str, notice: str) -> str:
    requirements = prompt_path(vol).read_text(encoding="utf-8")
    extra = instruction.strip() or "无"
    notice_text = notice.strip() or "无"
    return f"""你是专业的电子出版物编辑。附件图像按顺序对应 MEW 第 {vol} 卷物理页码 {pages}。

你已经是主调度器启动的独立页面转换 worker。直接读取本消息附件并返回结果；不要再次调用 codex_pdf_convert.py，不要启动其他 agent，也不要写文件。

请把这一组页面连续转换为高质量 HTML，严格遵守下列格式要求。正确合并跨页段落；不要重复页眉；如页面与相邻篇目重叠，只保留本组中完整出现的篇目内容。不得臆造看不清的字符。

用户附加要求：{extra}
项目 NOTICE：{notice_text}

转换要求：
{requirements}

最终响应只能包含 HTML 源码，不要解释，不要使用 Markdown 代码围栏。结果必须包含一个 <title> 元素和一个 <body>...</body> 元素。"""


def normalize_html(raw: str) -> str:
    text = raw.strip().lstrip("\ufeff")
    fenced = re.fullmatch(r"```(?:html)?\s*(.*?)\s*```", text, re.IGNORECASE | re.DOTALL)
    if fenced:
        text = fenced.group(1).strip()
    if not text:
        raise ValueError("Codex 返回了空结果")
    if not re.search(r"<title\b[^>]*>.*?</title>", text, re.IGNORECASE | re.DOTALL):
        raise ValueError("Codex 结果缺少 <title> 元素")
    if not re.search(r"<body\b[^>]*>.*?</body>", text, re.IGNORECASE | re.DOTALL):
        raise ValueError("Codex 结果缺少完整的 <body> 元素")
    if "```" in text:
        raise ValueError("Codex 结果仍包含 Markdown 代码围栏")
    return text + ("\n" if not text.endswith("\n") else "")


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", newline="\n", delete=False, dir=path.parent, suffix=".tmp"
    ) as handle:
        handle.write(content)
        temp_path = Path(handle.name)
    os.replace(temp_path, path)


@dataclass(frozen=True)
class Job:
    pages: list[int]
    output: Path


def jobs_from_plan(plan: dict, output_dir: Path, allow_partial: bool) -> list[Job]:
    if (plan["partial_groups"] or plan["unknown_pages"]) and not allow_partial:
        raise ValueError(
            "请求没有完整覆盖所有相关页码组；请先查看 plan，确认后使用 --allow-partial 按字面页码转换"
        )
    groups = [
        item["known_group"] if item["complete"] else item["selected_pages"]
        for item in plan["groups"]
    ]
    groups.extend([[page] for page in plan["unknown_pages"]])
    return [Job(pages=group, output=output_dir / output_name(plan["volume"], group[0])) for group in groups]


def codex_command(args: argparse.Namespace, images: list[Path], response_file: Path) -> list[str]:
    executable = shutil.which("codex")
    if not executable:
        raise FileNotFoundError("PATH 中找不到 codex CLI")
    command = [
        executable,
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        "--cd",
        str(WORKSPACE),
    ]
    command.extend(["--model", args.model or DEFAULT_CODEX_MODEL])
    if args.profile:
        command.extend(["--profile", args.profile])
    command.extend(["--image", *[str(path) for path in images]])
    command.extend(["--output-last-message", str(response_file), "-"])
    return command


def ensure_chatgpt_auth() -> str:
    executable = shutil.which("codex")
    if not executable:
        raise FileNotFoundError("PATH 中找不到 codex CLI")
    completed = subprocess.run(
        [executable, "login", "status"],
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    status = (completed.stdout or "").strip()
    if completed.returncode != 0:
        raise RuntimeError(
            f"Codex CLI 尚未登录，未启动任何转换。请先运行 codex login --device-auth；当前状态：{status or '未知'}"
        )
    if "chatgpt" not in status.lower():
        raise RuntimeError(
            "Codex CLI 当前未明确使用 ChatGPT 登录；为避免 API-key 计费，已停止。"
            f"当前状态：{status or '未知'}"
        )
    return status


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def convert_job(
    args: argparse.Namespace,
    job: Job,
    pdf: Path,
    cache_dir: Path,
    notice: str,
    temp_dir: Path,
) -> dict:
    if job.output.exists() and not args.force:
        return {"status": "skipped", "pages": job.pages, "output": str(job.output)}
    images = render_pages(pdf, cache_dir, args.dpi, job.pages)
    response_file = temp_dir / f"response-{job.pages[0]:04d}-{job.pages[-1]:04d}.txt"
    command = codex_command(args, images, response_file)
    if args.dry_run:
        return {
            "status": "dry-run",
            "pages": job.pages,
            "output": str(job.output),
            "images": [str(path) for path in images],
            "command": command,
        }
    prompt = build_prompt(args.vol, job.pages, args.instruction, notice)
    completed = subprocess.run(
        command,
        cwd=WORKSPACE,
        input=prompt,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if completed.returncode != 0:
        tail = completed.stdout[-4000:] if completed.stdout else ""
        raise RuntimeError(f"codex exec 退出码 {completed.returncode}\n{tail}")
    if not response_file.is_file():
        raise RuntimeError("codex exec 未生成 --output-last-message 文件")
    html = normalize_html(response_file.read_text(encoding="utf-8"))
    atomic_write(job.output, html)
    return {"status": "completed", "pages": job.pages, "output": str(job.output)}


def add_common_paths(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--workspace",
        help="工作区根目录；也可设置 MEW_PDF_WORKSPACE。相对的 PDF/缓存/输出路径以此为基准",
    )
    parser.add_argument("--vol", type=int, required=True, help="MEW 卷号；261-263 表示第 26 卷分册")
    parser.add_argument("--pages", type=parse_pages, required=True, help="例如 3-8,12")
    parser.add_argument("--pdf", help="覆盖默认 PDF 路径")
    parser.add_argument("--cache-dir", help="覆盖默认 PNG 缓存目录")
    parser.add_argument("--output-dir", help="覆盖默认 HTML 输出目录")
    parser.add_argument("--dpi", type=int, default=150, help="页面渲染 DPI，默认 150")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    plan = subparsers.add_parser("plan", help="显示请求页码与 MEWbrief 页码组的对应关系")
    add_common_paths(plan)

    render = subparsers.add_parser("render", help="只渲染并输出页面 PNG 路径")
    add_common_paths(render)

    manifest = subparsers.add_parser(
        "manifest", help="按已知页码组渲染图片，并输出供原生子 agent 使用的绝对路径清单"
    )
    add_common_paths(manifest)
    manifest.add_argument("--allow-partial", action="store_true", help="允许按字面页码生成不完整页码组")
    manifest.add_argument("--force", action="store_true", help="在清单中标记允许覆盖已有输出")

    convert = subparsers.add_parser("convert", help="每个页码组启动一次 codex exec 并保存 HTML")
    add_common_paths(convert)
    convert.add_argument("--instruction", default="", help="传给每个转换子任务的附加要求")
    convert.add_argument("--workers", type=int, default=1, choices=range(1, 5), metavar="1-4")
    convert.add_argument("--model", help="可选 Codex 模型覆盖；默认使用本机配置")
    convert.add_argument("--profile", help="可选 Codex 配置 profile")
    convert.add_argument("--allow-partial", action="store_true", help="按字面页码转换不完整或未知分组")
    convert.add_argument("--force", action="store_true", help="覆盖已有输出")
    convert.add_argument("--dry-run", action="store_true", help="渲染图片并显示命令，但不调用 Codex")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    plan = make_plan(args.vol, args.pages)
    if args.command == "plan":
        plan["workspace"] = str(WORKSPACE)
        print(json.dumps(plan, ensure_ascii=False, indent=2))
        return 0

    pdf, cache_dir, output_dir = resolve_paths(args)
    if args.command == "render":
        images = render_pages(pdf, cache_dir, args.dpi, args.pages)
        result = {
            "volume": args.vol,
            "pages": args.pages,
            "pdf": str(pdf),
            "images": [str(path) for path in images],
            "suggested_output": str(output_dir / output_name(args.vol, args.pages[0])),
            "requirements": str(prompt_path(args.vol)),
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0


    if args.command == "manifest":
        jobs = jobs_from_plan(plan, output_dir, args.allow_partial)
        requirements = prompt_path(args.vol).resolve()
        if not requirements.is_file():
            raise FileNotFoundError(f"转换提示词不存在：{requirements}")
        notice_path = (cache_dir / "NOTICE.md").resolve()
        result = {
            "workspace": str(WORKSPACE),
            "volume": args.vol,
            "requested_pages": args.pages,
            "pdf": str(pdf.resolve()),
            "requirements": str(requirements),
            "notice": str(notice_path) if notice_path.is_file() else None,
            "jobs": [
                {
                    "pages": job.pages,
                    "images": [
                        str(path) for path in render_pages(pdf, cache_dir, args.dpi, job.pages)
                    ],
                    "output": str(job.output.resolve()),
                    "force": bool(args.force),
                }
                for job in jobs
            ],
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    jobs = jobs_from_plan(plan, output_dir, args.allow_partial)
    needs_codex = any(args.force or not job.output.exists() for job in jobs)
    auth_status = None if args.dry_run or not needs_codex else ensure_chatgpt_auth()
    if not args.dry_run:
        output_dir.mkdir(parents=True, exist_ok=True)
    temp_dir = output_dir / ".codex-pdf-tmp"
    if not args.dry_run:
        temp_dir.mkdir(parents=True, exist_ok=True)
    notice_path = cache_dir / "NOTICE.md"
    notice = notice_path.read_text(encoding="utf-8") if notice_path.is_file() else ""
    log_path = output_dir / "codex-pdf-convert.jsonl"
    log_lock = threading.Lock()
    results: list[dict] = []

    def record(result: dict) -> None:
        event = {"time": utc_now(), "volume": args.vol, **result}
        if not args.dry_run:
            with log_lock:
                with log_path.open("a", encoding="utf-8", newline="\n") as handle:
                    handle.write(json.dumps(event, ensure_ascii=False) + "\n")
        print(json.dumps(event, ensure_ascii=False), flush=True)

    failures = 0
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        future_map = {
            executor.submit(convert_job, args, job, pdf, cache_dir, notice, temp_dir): job
            for job in jobs
        }
        for future in as_completed(future_map):
            job = future_map[future]
            try:
                result = future.result()
            except Exception as exc:  # Keep other independent groups running.
                failures += 1
                result = {
                    "status": "failed",
                    "pages": job.pages,
                    "output": str(job.output),
                    "error": str(exc),
                }
            results.append(result)
            record(result)

    summary = {
        "volume": args.vol,
        "jobs": len(results),
        "completed": sum(item["status"] == "completed" for item in results),
        "skipped": sum(item["status"] == "skipped" for item in results),
        "dry_run": sum(item["status"] == "dry-run" for item in results),
        "failed": failures,
        "auth": auth_status,
        "log": None if args.dry_run else str(log_path),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, FileNotFoundError, RuntimeError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        raise SystemExit(2)
