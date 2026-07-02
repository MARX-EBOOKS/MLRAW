import json
import os
import re
from pathlib import Path
from typing import List, Tuple, Dict, Optional, NamedTuple
from dataclasses import dataclass, field
from bs4 import BeautifulSoup, NavigableString, Tag
from urllib.parse import unquote, urlsplit
import chapternumbergerman
import MEWbriefzeno as MEWbrief
import pageindex


@dataclass
class SourcePage:
    path: Path
    volume: int
    page: int
    page_source: str
    content: str
    old_url: str
    source_order: int = 0
    output: str = ""
    anchor: str = ""



def source_aliases(source: SourcePage) -> set[str]:
    """一个源网页在链接中可能出现的全部精确路径形式。"""
    aliases = {
        canonical_path(source.path.name),
        canonical_path(source.path.as_posix()),
        canonical_path("/" + source.path.name),
    }
    if source.old_url:
        aliases.add(canonical_path(source.old_url))
    return aliases


def source_alias_map(sources: List[SourcePage]) -> Dict[str, SourcePage]:
    """普通链接重写使用；脚注匹配另用保留重复项的复合键索引。"""
    result: Dict[str, SourcePage] = {}
    for source in sources:
        for alias in source_aliases(source):
            result[alias] = source
    return result


def input_html_files(input_dir: Path) -> List[Path]:
    """直接遍历卷目录网页，不依赖 EPUB 的 OPF/manifest/spine。"""
    return sorted(
        list(input_dir.glob("*.html")) + list(input_dir.glob("*.xhtml")),
        key=lambda item: item.name.casefold(),
    )


def canonical_path(url: str) -> str:
    return unquote(urlsplit(url).path).rstrip("/") or "/"


def group_for_page(volume: int, page: int) -> Optional[List[int]]:
    for group in MEWbrief.page_group[volume]:
        if page in group:
            return group
    return None


def output_filename(volume: int, start_page: int) -> str:
    return f"ME{volume:02d}-{start_page:03d}.html"


def detect_page(
    processed_content: str,
    path: Path,
    volume: int,
    footer_text: str = "",
) -> Tuple[int, str]:
    """footer 元数据 -> recont 结果中的首个 S 锚点 -> 文件名。"""
    match = re.search(
        rf"\bBand\s+{re.escape(str(volume))}\s*,\s*S\.\s*(\d+)",
        footer_text,
        re.I,
    )
    if match:
        return int(match.group(1)), "footer"
    match = re.search(
        r'<a\b[^>]*\b(?:id|name)=["\']?S(\d+)',
        processed_content,
        re.I,
    )
    if match:
        return int(match.group(1)), "anchor"
    match = re.search(r"(\d{1,4})\D*$", path.stem)
    if not match:
        raise ValueError(f"无法探测页码: {path}")
    return int(match.group(1)), "filename"


def rewrite_links(html: str, current_output: str, link_map: Dict[str, SourcePage]) -> str:
    soup = BeautifulSoup(html, "html.parser")
    seen_ids = set()
    for element in soup.find_all(id=True):
        element_id = str(element["id"])
        if element_id in seen_ids:
            del element["id"]
        else:
            seen_ids.add(element_id)
    current_dir = Path(current_output).parent
    for link in soup.find_all("a", href=True):
        parsed = urlsplit(str(link["href"]))
        if not parsed.path:
            continue
        if parsed.netloc and "zeno.org" not in parsed.netloc.lower():
            continue
        target = link_map.get(canonical_path(str(link["href"])))
        if target is None:
            continue
        relative = Path(os.path.relpath(target.output, current_dir)).as_posix()
        fragment = parsed.fragment or target.anchor
        link["href"] = f"{relative}#{fragment}" if fragment else relative
    return str(soup)


# ── 统一脚注模型：作者脚注与 Lesarten ─────────────────────────

@dataclass
class Footnote:
    old_id: str
    label: str
    category: str
    back_href: str
    first_content: str
    extra_blocks: List[str]
    source: SourcePage
    order: int
    target_output: str = ""
    new_id: str = ""
    new_ref: str = ""


class FootnoteManager:
    NOTE_ID_RE = re.compile(r"^(?:FA|F|fnA|fn)[A-Za-z0-9*]+$", re.I)
    LABEL_RE = re.compile(r"^(?:A\s*)?\d+$", re.I)

    def __init__(self, volume: int):
        self.volume = volume
        self.notes: List[Footnote] = []
        # 核心索引：绝不只以 fragment 为键。
        self.by_note_link: Dict[Tuple[str, str], List[Footnote]] = {}
        self.sources_by_alias: Dict[str, List[SourcePage]] = {}
        self.notes_by_output: Dict[str, Dict[str, List[Footnote]]] = {}
        self._ref_occurrences: Dict[str, int] = {}
        self.unresolved_notes: List[Footnote] = []
        self.inline_endnote_labels: Dict[Path, set[str]] = {}
        self._category_counts = {"fussnoten": 0, "lesarten": 0}

    def _next_number(self, category: str) -> int:
        self._category_counts[category] += 1
        return self._category_counts[category]

    @staticmethod
    def _category(old_id: str, label: str) -> str:
        if label.upper().startswith("A") or re.match(r"^(?:FA|fnA)", old_id, re.I):
            return "lesarten"
        return "fussnoten"

    @staticmethod
    def _split_first_block(block: Tag, anchor: Tag) -> str:
        clone = BeautifulSoup(str(block), "html.parser").find(block.name)
        copied_anchor = clone.find(
            "a", id=lambda value: value and str(value) == str(anchor.get("id", ""))
        )
        if copied_anchor:
            copied_anchor.decompose()
        return clone.decode_contents().strip()

    @staticmethod
    def _href_aliases(source: SourcePage, href: str) -> set[str]:
        """相对链接按当前源文件解析；绝对 URL 保持其完整规范路径。"""
        parsed = urlsplit(href)
        if not parsed.path:
            return source_aliases(source)
        path_key = canonical_path(href)
        aliases = {path_key}
        if not parsed.path.startswith("/"):
            aliases.add(canonical_path(Path(parsed.path).name))
            aliases.add(
                canonical_path((source.path.parent / unquote(parsed.path)).as_posix())
            )
        return aliases

    @staticmethod
    def _dedupe(items: List) -> List:
        result = []
        seen = set()
        for item in items:
            marker = id(item)
            if marker not in seen:
                seen.add(marker)
                result.append(item)
        return result

    def collect_source(self, source: SourcePage) -> None:
        """页脚和独立脚注页统一消化，并登记“脚注页路径 + ID”。"""
        soup = BeautifulSoup(source.content, "html.parser")
        for aside in soup.find_all("aside"):
            current: Optional[Footnote] = None
            for child in aside.children:
                if not isinstance(child, Tag):
                    continue
                anchor = child.find("a", id=True)
                old_id = str(anchor.get("id", "")) if anchor else ""
                label = anchor.get_text(" ", strip=True) if anchor else ""
                is_start = bool(
                    anchor
                    and self.NOTE_ID_RE.fullmatch(old_id)
                    and self.LABEL_RE.fullmatch(label.replace(" ", ""))
                )
                if is_start:
                    category = self._category(old_id, label)
                    number = self._next_number(category)
                    current = Footnote(
                        old_id=old_id,
                        label=label,
                        category=category,
                        back_href=str(anchor.get("href", "")),
                        first_content=self._split_first_block(child, anchor),
                        extra_blocks=[],
                        source=source,
                        order=len(self.notes),
                        new_id=(f"fnA{number}" if category == "lesarten" else f"fn{number}"),
                        new_ref=(f"fnA{number}ref" if category == "lesarten" else f"fn{number}ref"),
                    )
                    self.notes.append(current)
                    fragment = old_id.casefold()
                    for alias in source_aliases(source):
                        self.by_note_link.setdefault((alias, fragment), []).append(current)
                elif current is not None and child.name not in ("br",):
                    current.extra_blocks.append(str(child))
        for ref in soup.find_all("a", href=True, id=True):
            parsed = urlsplit(str(ref["href"]))
            old_id = unquote(parsed.fragment)
            if not re.match(r"^(?:Fuß|Fuss)noten_", old_id, re.I):
                continue
            label = ref.get_text(" ", strip=True)
            definition = None
            definition_anchor = None
            for paragraph in soup.select("p.fni"):
                anchor = paragraph.find("a", href=True)
                if anchor and anchor.get_text(" ", strip=True) == label:
                    definition = paragraph
                    definition_anchor = anchor
                    break
            if definition is None or definition_anchor is None:
                continue
            category = "fussnoten"
            number = self._next_number(category)
            clone = BeautifulSoup(str(definition), "html.parser").find("p")
            copied_anchor = clone.find("a")
            if copied_anchor:
                copied_anchor.decompose()
            content = clone.decode_contents().strip()
            content = re.sub(r"^\[\s*|\s*\]$", "", content).strip()
            note = Footnote(
                old_id=old_id,
                label=label,
                category=category,
                back_href=f'#{ref.get("id")}',
                first_content=content,
                extra_blocks=[],
                source=source,
                order=len(self.notes),
                new_id=f"fn{number}",
                new_ref=f"fn{number}ref",
            )
            self.notes.append(note)
            for alias in source_aliases(source):
                self.by_note_link.setdefault(
                    (alias, old_id.casefold()), []
                ).append(note)
            self.inline_endnote_labels.setdefault(source.path, set()).add(label)

    @staticmethod
    def _source_is_note_only(source: SourcePage) -> bool:
        soup = BeautifulSoup(source.content, "html.parser")
        body = soup.find("body")
        if body is None:
            return False
        for aside in body.find_all("aside"):
            aside.decompose()
        return not " ".join(body.stripped_strings)

    def _sources_for_href(self, source: SourcePage, href: str) -> List[SourcePage]:
        matches: List[SourcePage] = []
        for alias in self._href_aliases(source, href):
            matches.extend(self.sources_by_alias.get(alias, []))
        return self._dedupe(matches)

    def _notes_for_link(self, source: SourcePage, href: str) -> List[Footnote]:
        fragment = unquote(urlsplit(href).fragment).casefold()
        if not fragment:
            return []
        matches: List[Footnote] = []
        for alias in self._href_aliases(source, href):
            matches.extend(self.by_note_link.get((alias, fragment), []))
        return self._dedupe(matches)

    def resolve_targets(self, sources: List[SourcePage]) -> None:
        for source in sources:
            for alias in source_aliases(source):
                self.sources_by_alias.setdefault(alias, []).append(source)

        # 脚注正文内部锚点也必须带脚注页路径，避免不同文章的 N1/NA1 串线。
        ref_owners: Dict[Tuple[str, str], List[Footnote]] = {}
        for note in self.notes:
            fragment = BeautifulSoup(
                note.first_content + "".join(note.extra_blocks), "html.parser"
            )
            for element in fragment.find_all(id=True):
                ref_id = str(element["id"]).casefold()
                for alias in source_aliases(note.source):
                    ref_owners.setdefault((alias, ref_id), []).append(note)

        # 第一层：脚注直接回链到正文页。
        for note in self.notes:
            parsed = urlsplit(note.back_href)
            if not parsed.path:
                note.target_output = note.source.output
                continue
            targets = [
                target for target in self._sources_for_href(note.source, note.back_href)
                if not self._source_is_note_only(target)
            ]
            if len(targets) == 1:
                note.target_output = targets[0].output

        # 第二层：Lesart 回链到作者脚注内部，再沿作者脚注归属到正文。
        changed = True
        while changed:
            changed = False
            for note in self.notes:
                if note.target_output:
                    continue
                parsed = urlsplit(note.back_href)
                if not parsed.fragment:
                    continue
                owners: List[Footnote] = []
                for alias in self._href_aliases(note.source, note.back_href):
                    owners.extend(
                        ref_owners.get((alias, unquote(parsed.fragment).casefold()), [])
                    )
                owners = self._dedupe(owners)
                resolved_outputs = {
                    owner.target_output for owner in owners if owner.target_output
                }
                if len(resolved_outputs) == 1:
                    note.target_output = resolved_outputs.pop()
                    changed = True

        self.unresolved_notes = [
            note for note in self.notes if not note.target_output
        ]
        self.notes_by_output.clear()
        for note in self.notes:
            if not note.target_output:
                continue
            categories = self.notes_by_output.setdefault(
                note.target_output, {"fussnoten": [], "lesarten": []}
            )
            categories[note.category].append(note)

    def _find_note(
        self, source: SourcePage, href: str, current_output: str
    ) -> Optional[Footnote]:
        candidates = self._notes_for_link(source, href)
        if len(candidates) == 1:
            return candidates[0]
        same_output = [
            note for note in candidates if note.target_output == current_output
        ]
        return same_output[0] if len(same_output) == 1 else None

    def patch_links(
        self, soup: BeautifulSoup, source: SourcePage, current_output: str
    ) -> None:
        current_dir = Path(current_output).parent
        for link in soup.find_all("a", href=True):
            note = self._find_note(source, str(link["href"]), current_output)
            if note is None or not note.target_output:
                continue
            if note.target_output == current_output:
                link["href"] = f"#{note.new_id}"
            else:
                relative = Path(
                    os.path.relpath(note.target_output, current_dir)
                ).as_posix()
                link["href"] = f"{relative}#{note.new_id}"
            occurrence = self._ref_occurrences.get(note.new_ref, 0)
            self._ref_occurrences[note.new_ref] = occurrence + 1
            link["id"] = (
                note.new_ref if occurrence == 0
                else f"{note.new_ref}-{occurrence}"
            )

    def prepare_body(self, source: SourcePage, current_output: str) -> str:
        soup = BeautifulSoup(source.content, "html.parser")
        body = soup.find("body")
        if body is None or self._source_is_note_only(source):
            return ""
        for aside in body.find_all("aside"):
            # 只有已被 Footnote 数组完整接管的脚注区才从正文移除。
            # 未识别的 aside 保留原样，避免 recont 建好的本地链接失去目标。
            consumed = False
            for anchor in aside.find_all("a", id=True):
                fragment = str(anchor["id"]).casefold()
                if any(
                    self.by_note_link.get((alias, fragment))
                    for alias in source_aliases(source)
                ):
                    consumed = True
                    break
            if consumed:
                aside.decompose()
        consumed_labels = self.inline_endnote_labels.get(source.path, set())
        for paragraph in list(body.select("p.fni")):
            anchor = paragraph.find("a", href=True)
            if anchor and anchor.get_text(" ", strip=True) in consumed_labels:
                paragraph.decompose()
        self.patch_links(body, source, current_output)
        return "".join(str(child) for child in body.children).strip()

    def _render_note_content(self, note: Footnote) -> Tuple[str, List[str]]:
        first = BeautifulSoup(note.first_content, "html.parser")
        self.patch_links(first, note.source, note.target_output)
        extras: List[str] = []
        for block in note.extra_blocks:
            fragment = BeautifulSoup(block, "html.parser")
            self.patch_links(fragment, note.source, note.target_output)
            extras.append("".join(str(child) for child in fragment.contents))
        return "".join(str(child) for child in first.contents), extras

    def render(self, output: str) -> str:
        sections: List[str] = []
        categories = self.notes_by_output.get(
            output, {"fussnoten": [], "lesarten": []}
        )
        for category, heading in (
            ("fussnoten", "Fußnoten"),
            ("lesarten", "Lesarten"),
        ):
            notes = categories[category]
            if not notes:
                continue
            lines = [
                f'<aside class="fn {category}">',
                f'<div class="fnt">{heading}</div>',
            ]
            for note in sorted(notes, key=lambda item: item.order):
                first, extras = self._render_note_content(note)
                lines.append(f'<p class="fni"><a id="{note.new_id}" href="#{note.new_ref}">{note.label}</a> {first}</p>')
                lines.extend(extras)
            lines.append("</aside>")
            sections.append("\n".join(lines))
        return "\n".join(sections)


class PageMerger:
    """
    页面合并器
    负责管理整个合并流程
    """
    def __init__(self, volume: int, input_dir: Path, output_dir: Path):
        self.volume = volume
        self.input_dir = input_dir
        self.output_dir = output_dir
        self.page_group = MEWbrief.page_group[volume]
        self.sources: List[SourcePage] = []
        self.sources_by_page: Dict[int, List[SourcePage]] = {}

        extra_groups: List[List[int]] = []
        input_files = input_html_files(input_dir)
        for source_order, path in enumerate(input_files):
            raw_content = path.read_text(encoding="utf-8-sig")
            if not re.search(r"<body\b", raw_content, re.I):
                continue

            # 原文件到此为止只负责提供元数据；正文从这里起只有 recont 结果。
            raw_metadata = BeautifulSoup(raw_content, "html.parser")
            footer = raw_metadata.find(class_="zenoCOFooterLineRight")
            footer_text = " ".join(footer.stripped_strings) if footer else ""
            meta = raw_metadata.find("meta", attrs={"property": "og:url"})
            old_url = str(meta.get("content", "")) if meta else ""

            processed_content = self.recont(raw_content)
            page, page_source = detect_page(processed_content, path, volume, footer_text)
            source = SourcePage(
                path,
                volume,
                page,
                page_source,
                processed_content,
                old_url,
                source_order
            )
            group = group_for_page(volume, page)
            if group is None:
                # 卷首、附录等未列入 MEWbrief1 时保持为单文件篇目。
                group = [page]
                if group not in extra_groups:
                    extra_groups.append(group)
            source.output = f"{volume}/{output_filename(volume, group[0])}"
            source.anchor = f"S{page}"
            self.sources.append(source)
            self.sources_by_page.setdefault(page, []).append(source)

        self.page_group = sorted(
            list(self.page_group) + extra_groups, key=lambda group: group[0]
        )
        self.sources.sort(key=lambda item: (item.page, item.source_order))
        for sources in self.sources_by_page.values():
            sources.sort(key=lambda item: item.source_order)
        self.footnotes = FootnoteManager(volume)
        for source in self.sources:
            self.footnotes.collect_source(source)
        self.footnotes.resolve_targets(self.sources)
    def rehead_ka(self,match):
        recontent=match.group(2)
        recontent=re.sub(r'''<(h[\d])[^<]*?>([IV]+?)\.\s+([\S\s]+?)</h[\d]>''',chapternumbergerman.abschnitt_no,recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r'''<(h[\d])[^<]*?>([\d]+?)\.\s+([\S\s]+?)</h[\d]>''',chapternumbergerman.kaptiel_no,recontent,flags=re.DOTALL|re.IGNORECASE)
        anchor=match.group(1) if match.group(1) else ''
        return anchor+recontent

    @staticmethod
    def _normalize_footer_footnotes(recontent: str) -> str:
        """
        把 Zeno/EPUB 页面末尾的 ``p.fn`` 脚注区转成统一的 aside。

        旧正则要求脚注区前后各有一个 emptyLine，并且标题编码必须完全
        一致；文件末尾少一个空行或使用正常的 ß 时，整组脚注就会漏掉。
        """
        soup = BeautifulSoup(recontent, "html.parser")

        def normalize_note_paragraph(node: Tag) -> bool:
            if node.find(
                "a",
                id=lambda value: value
                and re.fullmatch(r"(?:fnA?\d+|FA\d+|F\d+)", str(value), re.I),
            ):
                return False
            first_text = next(
                (
                    text for text in node.descendants
                    if isinstance(text, NavigableString) and text.strip()
                ),
                None,
            )
            match = (
                re.match(r"^\s*(A?\d+)\s+(.*)$", str(first_text), re.S)
                if first_text is not None else None
            )
            if not match:
                return False
            label = match.group(1)
            first_text.replace_with(match.group(2))
            anchor = soup.new_tag(
                "a", id=f"fn{label}", href=f"#fn{label}ref"
            )
            anchor.string = label
            node.insert(0, " ")
            node.insert(0, anchor)
            node["class"] = ["fni"]
            return True

        for heading in list(soup.select("p.fn")):
            aside = soup.new_tag("aside")
            aside["class"] = ["fn"]
            title = soup.new_tag("div")
            title["class"] = ["fnt"]
            title.string = heading.get_text(" ", strip=True) or "Fußnoten"
            aside.append(title)

            sibling = heading.next_sibling
            note_nodes = []
            while sibling is not None:
                next_sibling = sibling.next_sibling
                if isinstance(sibling, Tag):
                    if sibling.name in ("h1", "h2", "h3", "h4", "h5", "h6"):
                        break
                    if sibling.name == "p" and "fn" in sibling.get("class", []):
                        break
                note_nodes.append(sibling)
                sibling = next_sibling

            heading.replace_with(aside)
            for node in note_nodes:
                if (
                    isinstance(node, Tag)
                    and node.name == "div"
                    and "emptyLine" in node.get("class", [])
                ):
                    node.extract()
                    continue

                if isinstance(node, Tag) and node.name == "p":
                    normalize_note_paragraph(node)

                aside.append(node.extract())

        # 有些脚注区已被旧正则包进 aside，但其段落先一步变成了 p.ni，
        # 因而没有生成脚注锚点；这里一并补齐。
        for aside in soup.find_all("aside"):
            for paragraph in aside.find_all("p"):
                normalize_note_paragraph(paragraph)

        # recont 原有规则会把所有裸 <sup> 都先改成脚注链接。这里只保留
        # 确实能在本文件脚注区中找到定义的链接，其余恢复为普通上标。
        defined_ids = {
            str(anchor["id"]).casefold()
            for aside in soup.find_all("aside")
            for anchor in aside.find_all("a", id=True)
            if re.fullmatch(r"(?:fnA?\d+|FA\d+|F\d+)", str(anchor["id"]), re.I)
        }
        for link in list(soup.select("sup > a[id][href]")):
            link_id = str(link.get("id", ""))
            target = unquote(urlsplit(str(link.get("href", ""))).fragment)
            if (
                re.fullmatch(r"fn(?:A\d*|\d+)ref", link_id, re.I)
                and re.fullmatch(r"fn(?:A\d*|\d+)", target, re.I)
                and target.casefold() not in defined_ids
            ):
                link.unwrap()

        return str(soup)

    def recont(self,recontent):
        def footnote(match):
            footnotes=match.group(1)
            footnotes=re.sub(r"(?!<tr><td[^<]*>[\s\r\n]*)<p>([A]*[\d]{1,2})\s+([\S])",r"""<p class="fni"><a href="#fn\1ref" id="fn\1">\1</a> \2""",footnotes,flags=re.DOTALL|re.IGNORECASE)
            footnotes=r"""<aside class="fn">
<div class="fnt">Fußnoten</div>
"""+footnotes+r"</aside>"
            return footnotes
        recontent=re.sub(r"""<a class="page" href="http[\S]+?">\[([\d]+?)\]</a>""",r'<a id="S\1"></a>',recontent,flags=re.DOTALL|re.IGNORECASE)
        #recontent=re.sub(r"[\r\n\s]{2,}",r" ",recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r"""<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="de" xml:lang="de">[\s\r\n\S]+?<div class="zenoCOMain">""",r"""<body>""",recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r"""<div class="zenoTRNavBottom">[\s\r\n\S]+?</html>""",r"</body>",recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r"""<div class="zenoCOFooter">[\s\r\n\S]+?</html>""",r"</body>",recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r"""<div class="zenoTXFnTable">\s*<table>""",r"""<aside class="fn">
<div class="fnt">Fußnoten</div>
""",recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r"""</table>\s*</div>\s*</body>""",r"</aside>\n</body>",recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r"""<tr>\s+<td>""",r"<tr><td>",recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r"""</td>\s+</tr>""",r"</td></tr>",recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r""" pp="no">""",r">",recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r'<p><a (?:id|name)=([\S]+?)(?: class="[\S ]+?")*></a><a(?: class="[\S ]+?")* href="([\S]+?)"(?: class="[\S ]+?")*>([\S]+?)</a> ',r'<p class="fni"><a href=\2 id=\1>\3</a> ',recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r"""<a href=[\S]+? class="zenoTXKonk" title="Vorlage" name="([\d]+?)">\[[\d]+?\]</a>""",r"""<a id="S\1"></a>""",recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent = recontent.replace(r"&szlig;", r"ß")
        recontent = recontent.replace(r"&ouml;", r"ö")
        recontent = recontent.replace(r"&auml;", r"ä")
        recontent = recontent.replace(r"&uuml;", r"ü")
        recontent = recontent.replace(r"&Szlig;", r"ẞ")
        recontent = recontent.replace(r"&Ouml;", r"Ö")
        recontent = recontent.replace(r"&Auml;", r"Ä")
        recontent = recontent.replace(r"&Uuml;", r"Ü")
        recontent=re.sub(r"""<a href=[\S]+? name=("[\S]+?") class="zenoTXFnRef">([A-Za-z\d]+?)</a>""",r"""<sup><a id=\1 href="#fn\2">\2</a></sup>""",recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r'<a(?: class="[^<]+?")* (?:id|name)=("[\S]+?")(?: class="[^<]+?")*>\s*</a>\s*<a(?: class="[^<]+?")* href=([\S]+?)(?: class="[^<]+?")*>(?:<sup>)*([\S]+?)(?:</sup>)*</a>',r'<sup><a href=\2 id=\1>\3</a></sup>',recontent ,flags=re.DOTALL | re.IGNORECASE)
        recontent=re.sub(r"""<tr><td><a\s*href=[\S]+?\s*name=("[\S]+?")\s*class="zenoTXFnText">([A\d]+?)</a></td>\s*<td><p>((?:(?!<(?:table|td)[^<]*>)[\S\s\r\n])+?)</p>(?:</td></tr>)*""",r"""<p class="fni"><a id=\1 href="#fn\2ref">\2</a> \3</p>""",recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r"""<p class="fn">Fußnoten</p>\s*<div class="emptyLine">&nbsp;</div>([\s\r\n\S]+?)<div class="emptyLine">&nbsp;</div>""",footnote,recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r"""<a\s*href=[\S]+?\s*name=("[\S]+?")\s*class="zenoTXFnText">([A\d]+?)</a>""",r"""<a id=\1 href="#fn\2ref">\2</a>""",recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r'<p class="zenoPR">([\s\r\n\S]+?)</p>',r'<p class="rgt">\1</p>',recontent ,flags=re.DOTALL | re.IGNORECASE)
        recontent=re.sub(r"""<p class="zenoPLm8n12"><span class="zenoTXColor2">([\S\s\r\n]+?)</span>(<a [\S ]+?</a>)*\s*</p>""",r'<blockquote><p class="poem">\1\2</p></blockquote>',recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r"""</p></blockquote>\s*<blockquote><p class="poem">""",'</p>\n<p class="poem">',recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r'<p class="zenoPLm8n12">',r'<p class="poem">',recontent,flags=re.DOTALL|re.IGNORECASE)
        if '<link rel="stylesheet" type="text/css" href="epub.css" />' in recontent:
            recontent=re.sub(r"""<p class="zenoPLm4n0"><i>([\S\s\r\n]+?)</i></p>[\s\r\n]+""",r"<blockquote>\1</blockquote>\n",recontent,flags=re.DOTALL|re.IGNORECASE)
            recontent=re.sub(r"""<p><i>([\S\s\r\n]+?)</i></p>""",r"""<blockquote class="ni">\1</blockquote>""",recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r"""<p><span class="zenoTXColor2">([\S\s\r\n]+?)</span>(<a [\S ]+?</a>)*\s*</p>""",r"""<blockquote class="ni">\1\2</blockquote>""",recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r"""<p class="zenoPLm4n0"><span class="zenoTXColor2">([\S\s\r\n]+?)</span>(<a [\S ]+?</a>)*\s*</p>""",r"<blockquote>\1\2</blockquote>",recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r"""<p class="zenoPC">""",r"""<p class="ctr">""",recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r"""<p>([\S\s\r\n]+?)</p>""",r"""<p class="ni">\1</p>""",recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r"""<p class="zenoPLm4n0">""",r"<p>",recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r"""<p id="an[\d]+?"\s*/>""",r"",recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r"""<h[\d]>(Fußnote[n]*|Lesart[en]*)</h[\d]>([\S\s\r\n]+?)(</body>|<h[\d])""",r"""<aside class="fn">
<div class="fnt">\1</div>
\2
</aside>
\3""",recontent,flags=re.DOTALL|re.IGNORECASE)

        # 分数中的上标（1/2、1<i>/</i><sub>2</sub>）不是脚注。
        not_fraction = r"(?!\s*(?:/|<i>\s*/\s*</i>)\s*<sub>)"
        recontent=re.sub(r"""<sup>([\d]+?)</sup>""" + not_fraction, r"""<sup><a href="#fn\1" id="fn\1ref">\1</a></sup>""", recontent, flags=re.DOTALL|re.IGNORECASE,)
        recontent=re.sub( r"""<sup>([A\d]+?)</sup>""" + not_fraction,r"""<sup><a href="#fn\1" id="fn\1ref">\1</a></sup>""", recontent, flags=re.DOTALL|re.IGNORECASE )
        recontent=re.sub(r"""<div class="emptyLine">&nbsp;</div>""",r"",recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r'([a-zA-Z])[ ]+(<sup><a[^<]+?>[\S]+?</a></sup>)[ ]*([\.,;])',r'\1\2\3',recontent ,flags=re.DOTALL | re.IGNORECASE)
        recontent=re.sub(r'([a-zA-Z])[ ]+(<sup><a[^<]+?>[\S]+?</a></sup>)[ ]*<',r'\1\2<',recontent ,flags=re.DOTALL | re.IGNORECASE)
        recontent=re.sub(r'[\.]+[ ]*(<sup><a[^<]+?>[\S]+?</a></sup>)[ ]+',r'\1. ',recontent ,flags=re.DOTALL | re.IGNORECASE)
        recontent=re.sub(r'[\.]+[ ]*(<sup><a[^<]+?>[\S]+?</a></sup>)',r'\1.',recontent ,flags=re.DOTALL | re.IGNORECASE)
        recontent=re.sub(r'>[ ]*(<sup><a[^<]+?>[\S]+?</a></sup>)[ ]+([\.,;])',r'>\1\2',recontent ,flags=re.DOTALL | re.IGNORECASE)
        recontent=re.sub(r'[ ]+(<sup><a[^<]+?>[\S]+?</a></sup>)</h',r'>\1</h',recontent ,flags=re.DOTALL | re.IGNORECASE)
        recontent=re.sub(r'(</(?:p|blockquote)>)[\s\r\n]*(<sup><a[^<]+?>[\S]+?</a></sup>)',r'\2\1',recontent ,flags=re.DOTALL | re.IGNORECASE)
        return recontent

    def merge_group(self, group_idx: int, page_list: List[int]) -> str:
        group_sources = [
            source
            for page in page_list
            for source in self.sources_by_page.get(page, [])
        ]
        if not group_sources:
            return ""
        current_output = f"{self.volume}/{output_filename(self.volume, page_list[0])}"
        # 引用后缀只在当前输出篇目内计数，确保脚注回链指向本篇第一个引用。
        self.footnotes._ref_occurrences.clear()
        main_contents: List[str] = []
        title_temp = ""
        for source in group_sources:
            body_content = self.footnotes.prepare_body(source, current_output)
            if not body_content:
                continue
            body = BeautifulSoup(body_content, "html.parser")
            page_anchor = f"S{source.page}"
            if body.find(id=page_anchor) is None:
                main_contents.append(
                    f'\n<a id="{page_anchor}"></a>\n'
                )
            main_contents.append(body_content)
            if not title_temp:
                title_temp = self.get_title(source.content) or ""

        footnotes_html = self.footnotes.render(current_output)
        if not main_contents and not footnotes_html:
            return ""
        return self._build_process_full_html(
            "\n".join(main_contents),
            footnotes_html,
            title_temp,
            page_list[0],
            page_list[-1],
        )

    def get_title(self,html_content:str) -> Optional[str]:
        """获取HTML文件的标题"""
        if not html_content:
            return None
        if self.volume in range(27,40):
            title_match=re.search(r"<title>([\S\r\n\s]+?)</title>",html_content,flags=re.IGNORECASE|re.DOTALL)
            if not title_match:
                print(html_content)
            title=title_match.group(1)
            title=re.sub(r"""^[\d]{1,4}[\s]*[·•][\s]*""",r"",title,flags=re.DOTALL|re.IGNORECASE)
            title=re.sub(r"""[\s]*[·•,][\s]*([\S\s]+?)$""",r" – \1", title,flags=re.DOTALL|re.IGNORECASE)
            title=re.sub(r"""[\s]*-[\s]+([\S\s]+?)$""",r" – \1", title,flags=re.DOTALL|re.IGNORECASE)
            return title
        soup = BeautifulSoup(html_content, 'html.parser')
        title_tag = soup.find(['h1','h2','h3','h4','h5','h6'])
        if title_tag:
            title=title_tag.get_text(strip=True,separator=" ")
            return title

        return None    

    def _build_process_full_html(self, body_content: str, 
                        footnotes_html: str,title_temp:str,start_page:int,end_page:int) -> str:
        """构建完整的HTML文档"""
        recontent=re.sub(r' style="(?:text-indent|margin-left): 2em;"',r'',body_content,flags=re.IGNORECASE|re.DOTALL)
        recontent = recontent.replace(r"&szlig;", r"ß")
        recontent = recontent.replace(r"&ouml;", r"ö")
        recontent = recontent.replace(r"&auml;", r"ä")
        recontent = recontent.replace(r"&uuml;", r"ü")
        recontent = recontent.replace(r"&Szlig;", r"ẞ")
        recontent = recontent.replace(r"&Ouml;", r"Ö")
        recontent = recontent.replace(r"&Auml;", r"Ä")
        recontent = recontent.replace(r"&Uuml;", r"Ü")
        recontent=re.sub(r"""<p>(?:<[\S]>)*(Aus dem [\S]+?en.)(?:</[\S]>)*</p>""",r"""<div class="que">\1</div>""",recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r"""<p>(Aus dem [\S]+?en und [\S]+?en.)</p>""",r"""<div class="que">\1</div>""",recontent,flags=re.DOTALL|re.IGNORECASE)
        if not self.volume in range(27,40):
            title=self.get_title(recontent)    
        if self.volume in range(261,264):
                vol=f"26.{self.volume-260}"
        else:
            vol=f"{self.volume}"
        if start_page==end_page:
            source=f"""<div class="que">Quelle: Marx/Engels: Werke, Bd. {vol}, Berlin: Dietz Verlag {MEWbrief.bookjahre[self.volume]}, S. {start_page}.</div>"""
        else:
            source=f"""<div class="que">Quelle: Marx/Engels: Werke, Bd. {vol}, Berlin: Dietz Verlag {MEWbrief.bookjahre[self.volume]}, S. {start_page}-{end_page}.</div>"""  
        if not title:
            title=f"MEW Band {self.volume}"
        recontent=re.sub(r"""<h[\d][^<]*>[\s\r\n]*([\[]*Karl Marx[\]]*|[\[]*Friedrich Engels[\]]*|[\[]*Karl Marx\s*/\s*Friedrich Engels[\]]*)</h[\d]>[\s\r\n]+<h[\d][^<]*?>([\s\S]+?)</h[\d]>""",r"<h1>\1<br>\2</h1>",recontent,flags=re.IGNORECASE|re.DOTALL)
        recontent=re.sub(r"""<p(?:(?!right)[^<])*>([\[]*Karl Marx[\]]*|[\[]*Friedrich Engels[\]]*|[\[]*Karl Marx/Friedrich Engels[\]]*)</p>[\s\r\n]+<h[\d][^<]*?>([\s\S]+?)</h[\d]>""",r"<h1>\1<br>\2</h1>",recontent,flags=re.IGNORECASE|re.DOTALL)
        recontent=re.sub(r'<div class="que">((?:(?!<div[^<]*?>)[\S\s\r\n])+?)</div>[\s\r\n]*<div class="que">',r'<div class="que">\1<br>',recontent,flags=re.IGNORECASE|re.DOTALL)
        title=re.sub(r"(Karl Marx|Friedrich Engels|Karl Marx\s*/\s*Friedrich Engels)[\s]+",r"\1 – ",title,flags=re.DOTALL|re.IGNORECASE)
        if self.volume in range(23,26):
            recontent=re.sub(r'^([\s\r\n]*<a id=[^<]+?></a>)*([\s\r\n]*<h[\d][^<]*>[\s\S\r\n]+?</h[\d]>)',self.rehead_ka,recontent,flags=re.IGNORECASE|re.DOTALL)
            recontent=re.sub(r'''(<h[\d][^<]*?>[\S]+? Abschnitt<br[/]*>(?:(?!<h[\d][^<]*>)[\S\r\n\s])+?</h[\d]>[\s\r\n]*)((?:<a[^<]*?></a>[\r\n\s]*)*<h[\d][^<]*?>[\d]+?\.\s+(?:(?!<h[\d][^<]*>)[\S\r\n\s])+?</h[\d]>)''',self.rehead_ka,recontent,flags=re.DOTALL|re.IGNORECASE)
            title=re.sub(r" (KAPITEL|ABSCHNITT) ",r" \1. ",title,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r'''(<h[\d])[^<]*?>''',r'\1>',recontent,flags=re.DOTALL|re.IGNORECASE)
        recontent=re.sub(r'''<(h[\d])[^<]*?>([\S]+? (?:KAPITEL|ABSCHNITT))</h[\d]>[\s\r\n]*<h[\d][^<]*?>([\s\S\r\n]+?)</h[\d]>''',r'<\1>\2<br>\3</\1>',recontent,flags=re.DOTALL|re.IGNORECASE)
        title=re.sub(r"(Karl Marx|Friedrich Engels|Karl Marx/Friedrich Engels)[\s]+",r"\1 – ",title,flags=re.DOTALL|re.IGNORECASE)
        return f'''<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>{title}</title>
<link rel="stylesheet" type="text/css" href="../mewde.css"/>
</head>
<body>
{recontent}
{footnotes_html}
{source}
</body>
</html>'''
    
    def run(self, link_map: Dict[str, SourcePage]) -> int:
        self.output_dir.mkdir(exist_ok=True, parents=True)
        index_content = ""
        written = 0
        for group_idx, page_list in enumerate(self.page_group):
            merged_html = self.merge_group(group_idx, page_list)
            if not merged_html:
                continue
            filename = output_filename(self.volume, page_list[0])
            merged_html = rewrite_links(
                merged_html, f"{self.volume}/{filename}", link_map
            )
            index_content += f'<a href="{filename}">{page_list[0]}</a><br>\n'
            (self.output_dir / filename).write_text(merged_html, encoding="utf-8", newline="\r\n")
            written += 1
        if not pageindex.pageindex[self.volume]:
            (self.output_dir / "index.html").write_text(index_content, encoding="utf-8", newline="\r\n")
        return written


def main():
    #volumes = list(range(1,11))+[13]+list(range(15,26))+[40]
    volumes = [6]
    output_root = Path("./23-251")
    mergers = [
        PageMerger(volume, Path(str(volume)), output_root / str(volume))
        for volume in volumes
    ]
    all_sources = [source for merger in mergers for source in merger.sources]
    link_map = {
        alias: source
        for alias, source in source_alias_map(all_sources).items()
        if source.output and not FootnoteManager._source_is_note_only(source)
    }
    written = sum(merger.run(link_map) for merger in mergers)
    output_root.mkdir(exist_ok=True, parents=True)
    mapping = {
        source.old_url: f"{source.output}#{source.anchor}"
        for source in all_sources if source.old_url and source.output
    }
    (output_root / "link-map.json").write_text(
        json.dumps(mapping, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    fallback = sum(source.page_source != "footer" for source in all_sources)
    unresolved_notes = sum(
        len(merger.footnotes.unresolved_notes) for merger in mergers
    )
    print(
        f"完成: {len(all_sources)} 个源文件 -> {written} 篇；"
        f"链接 {len(mapping)} 条；页码 fallback {fallback} 个；"
        f"未精确归属脚注 {unresolved_notes} 条"
    )


if __name__ == "__main__":
    main()
