"""按 KAPITEL 合并 ZENO 页面，并重写合并前后的内部链接。"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import unquote, urlsplit

from bs4 import BeautifulSoup, Tag

INPUT_DIR = Path(".")
OUTPUT_DIR = Path("./23-251")
VOLUMES = ("2","23", "24", "25")
HEADING_RE = re.compile(r"^h[1-6]$", re.I)
ROMAN_RE = re.compile(r"^([IVXLCDM]+)\.\s+\S", re.I)
NUMBER_RE = re.compile(r"^(\d+)\.\s+\S")
LETTER_RE = re.compile(r"^[a-z]\)\s+\S", re.I)
NOTE_TITLES = {"Fußnoten", "Lesarten"}


@dataclass
class Source:
    path: Path
    volume: str
    soup: BeautifulSoup
    main: Tag
    title: str
    old_url: str
    page: int | None
    kind: str = "other"
    output: str = ""
    anchor: str = ""


@dataclass
class Output:
    volume: str
    sources: list[Source] = field(default_factory=list)
    filename: str = ""


def text_of(tag: Tag | None) -> str:
    return " ".join(tag.stripped_strings) if tag else ""


def canonical_path(url: str) -> str:
    return unquote(urlsplit(url).path).rstrip("/") or "/"


def read_source(path: Path, volume: str) -> Source | None:
    soup = BeautifulSoup(path.read_text(encoding="utf-8-sig"), "html.parser")
    main = soup.find("div", class_="zenoCOMain")
    if main is None:
        return None
    title = text_of(main.find(HEADING_RE))
    meta = soup.find("meta", attrs={"property": "og:url"})
    old_url = str(meta.get("content", "")) if meta else ""
    footer = text_of(soup.find(class_="zenoCOFooterLineRight"))
    match = re.search(
        rf"\bBand\s+{re.escape(volume)}\s*,\s*S\.\s*(\d+)", footer, re.I
    )
    return Source(
        path, volume, soup, main, title, old_url,
        int(match.group(1)) if match else None,
    )


def load_volume(volume: str) -> list[Source]:
    records = (
        read_source(path, volume)
        for path in sorted((INPUT_DIR / volume).glob("*.html"))
    )
    return [record for record in records if record is not None]


def classify(records: list[Source]) -> None:
    """只根据 zenoCOMain 首标题序列识别章、篇及脚注类页面。"""
    numbered = [
        (index, int(match.group(1)))
        for index, record in enumerate(records)
        if (match := NUMBER_RE.match(record.title))
    ]
    # 从最大章号倒推。无正文的目录页优先；没有子目录的章则取下一章
    # 之前最后一个同号标题，可避开章内从 1 重新编号的小节。
    chapters: set[int] = set()
    upper = len(records)
    for number in range(max((n for _, n in numbered), default=0), 0, -1):
        candidates = [i for i, n in numbered if n == number and i < upper]
        bare = [i for i in candidates if not has_section_body(records[i])]
        if candidates:
            chosen = (bare or candidates)[-1]
            chapters.add(chosen)
            upper = chosen

    def roman_value(value: str) -> int:
        values = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100}
        total = previous = 0
        for char in reversed(value.upper()):
            current = values[char]
            total += -current if current < previous else current
            previous = current
        return total

    # 篇号在每卷中从 I 连续递增。裸篇标题优先；第一卷 VII 是唯一
    # 含正文的篇标题。这样不会把章内的罗马数字小节误判成篇。
    sections: set[int] = set()
    expected_section = 1
    for index, record in enumerate(records):
        match = ROMAN_RE.match(record.title)
        if not match or roman_value(match.group(1)) != expected_section:
            continue
        is_special_vii = (
            record.volume == "23" and match.group(1).upper() == "VII"
        )
        if not has_section_body(record) or is_special_vii:
            sections.add(index)
            expected_section += 1

    for index, record in enumerate(records):
        if record.title in NOTE_TITLES:
            record.kind = "note"
        elif index in chapters:
            record.kind = "chapter"
        elif index in sections:
            record.kind = "section"


def has_section_body(record: Source) -> bool:
    clone = BeautifulSoup(str(record.main), "html.parser")
    main = clone.find("div", class_="zenoCOMain")
    for element in main.find_all(HEADING_RE):
        element.decompose()
    for element in main.find_all("div", class_="zenoTRNavBottom"):
        element.decompose()
    return bool(text_of(main))


def make_groups(records: list[Source]) -> list[Output]:
    groups: list[Output] = []
    current: Output | None = None
    pending: Source | None = None

    def flush() -> None:
        nonlocal current
        if current and current.sources:
            groups.append(current)
        current = None

    for record in records:
        if record.kind == "note":
            flush()
            if pending:
                groups.append(Output(record.volume, [pending]))
                pending = None
            groups.append(Output(record.volume, [record]))
        elif record.kind == "section" and record.volume in range(23,26):
            flush()
            roman = ROMAN_RE.match(record.title)
            # 唯一例外：第一卷第七篇含正文，单独输出。
            if (
                record.volume == "23"
                and roman
                and roman.group(1).upper() == "VII"
                and has_section_body(record)
            ):
                groups.append(Output(record.volume, [record]))
            else:
                pending = record
        elif record.kind == "chapter":
            flush()
            current = Output(
                record.volume, ([pending] if pending else []) + [record]
            )
            pending = None
        elif current:
            current.sources.append(record)
        else:
            # 卷首、序言等不属于章，维持独立文件。
            groups.append(Output(record.volume, [record]))
    flush()
    if pending:
        groups.append(Output(pending.volume, [pending]))
    return groups


def assign_names(groups: list[Output]) -> None:
    used: set[str] = set()
    for group in groups:
        first = group.sources[0]
        if first.kind == "note":
            category = re.sub(r'[<>:"/\\|?*]+', "-", first.title).strip(" .")
            if category=='Lesarten':
                base = f"ME{group.volume}-LS"
            elif category=='Fußnoten':
                base = f"ME{group.volume}-FN"
            else:
                base = f"ME{group.volume}-ANM"
        elif first.page is not None:
            base = f"ME{group.volume}-{first.page:03d}"
        else:
            base = f"ME{group.volume}-{first.path.stem}"
        filename, serial = f"{base}.html", 2
        while f"{group.volume}/{filename}".casefold() in used:
            filename, serial = f"{base}-{serial}.html", serial + 1
        group.filename = filename
        used.add(f"{group.volume}/{filename}".casefold())
        for source in group.sources:
            source.output = f"{group.volume}/{filename}"
            source.anchor = f"src-{source.path.stem}"


def heading_level(title: str, kind: str) -> int | None:
    if kind == "section":
        return 1
    if kind == "chapter":
        return 2
    if ROMAN_RE.match(title):
        return 3
    if NUMBER_RE.match(title):
        return 4
    if LETTER_RE.match(title):
        return 5
    return None


def prepare_fragment(source: Source) -> Tag:
    fragment_soup = BeautifulSoup(str(source.main), "html.parser")
    main = fragment_soup.find("div", class_="zenoCOMain")
    for nav in main.find_all("div", class_="zenoTRNavBottom"):
        nav.decompose()
    wrapper = fragment_soup.new_tag("section", id=source.anchor)
    wrapper["data-source"] = source.path.as_posix()
    for child in list(main.contents):
        wrapper.append(child.extract())
    # 脚注内容（包括原标题标签）照旧。
    if source.kind != "note":
        for heading in wrapper.find_all(HEADING_RE):
            level = heading_level(text_of(heading), source.kind)
            if level:
                heading.name = f"h{level}"
    return wrapper


def rewrite_links(
    soup: BeautifulSoup, current_output: str, link_map: dict[str, Source]
) -> None:
    current_dir = Path(current_output).parent
    for link in soup.find_all("a", href=True):
        href = str(link["href"])
        parsed = urlsplit(href)
        if parsed.netloc and "zeno.org" not in parsed.netloc.lower():
            continue
        target = link_map.get(canonical_path(href))
        if target is None:
            continue
        relative = Path(os.path.relpath(target.output, current_dir)).as_posix()
        fragment = parsed.fragment or target.anchor
        link["href"] = f"{relative}#{fragment}" if fragment else relative


def render(group: Output, link_map: dict[str, Source]) -> str:
    title = group.sources[0].title if group.sources else ""
    sections = "".join(
        str(prepare_fragment(source))
        for source in group.sources
    )

    html = (
        "<html>"
        "<head><title>" + title + "</title></head>"
        '<body>'
        + sections +
        "</body>"
        "</html>"
    )

    document = BeautifulSoup(html, "html.parser")
    rewrite_links(document, f"{group.volume}/{group.filename}", link_map)
    return document.decode(formatter="html")


def main() -> None:
    records: list[Source] = []
    groups: list[Output] = []
    for volume in VOLUMES:
        volume_records = load_volume(volume)
        classify(volume_records)
        records.extend(volume_records)
        groups.extend(make_groups(volume_records))
    assign_names(groups)
    link_map = {
        canonical_path(source.old_url): source
        for source in records if source.old_url
    }
    OUTPUT_DIR.mkdir(exist_ok=True, parents=True)
    # 分组规则变化后，避免旧输出残留成看似有效的重复文件。
    for volume in VOLUMES:
        folder = OUTPUT_DIR / volume
        if folder.exists():
            for old_html in folder.glob("*.html"):
                old_html.unlink()
    for group in groups:
        folder = OUTPUT_DIR / group.volume
        folder.mkdir(exist_ok=True, parents=True)
        (folder / group.filename).write_text(
            render(group, link_map), encoding="utf-8"
        )
    mapping = {
        source.old_url: f"{source.output}#{source.anchor}"
        for source in records if source.old_url
    }
    (OUTPUT_DIR / "link-map.json").write_text(
        json.dumps(mapping, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(
        f"完成：{len(records)} 个源文件 -> {len(groups)} 个输出文件；"
        f"映射 {len(mapping)} 条。"
    )


if __name__ == "__main__":
    main()
