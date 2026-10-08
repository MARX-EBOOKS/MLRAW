#!/usr/bin/env python3
"""旧侧格式 + 新侧正文；Python 3.10+ 标准库，编辑配置后运行，两侧原文件不改写。"""
from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections import Counter, defaultdict, namedtuple
from dataclasses import dataclass
from difflib import SequenceMatcher
from functools import cached_property
from html import unescape
import json
from pathlib import Path
from os.path import commonprefix
import re

vol = 22
INPUT_DIR = f"../MEW_BRIEF_git/{vol}"      # +：新文件，所有正文均取自这里
REFERENCE_DIR = f"../MEW_BRIEF/{vol}"       # -：旧文件，格式取自这里
OUTPUT_DIR = f"../MEW_BRIEF_formats/{vol}"
ENCODING = "utf-8"
EXTENSIONS = {".html", ".htm", ".md", ".markdown"}

# None 对齐所有整标签；set() 不对齐整标签。保留规则独立，FORMAT_TAGS 优先。
FORMAT_TAGS: set[str] | None = {'p', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'b', 'i', 'br', 'hr'}
CONTEXT_TAGS: set[str] = {'*'}       # * 包括自定义标签
CONTEXT_EXCLUDED_TAGS: set[str] = {'p', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'b', 'i'}
REVIEW_ONLY_TAGS: set[str] = {'table', 'pre'}  # 差异块内部保留新格式，块边界取旧侧
TEXT_GAP_MIN_CHARS = 20             # 旧侧未匹配正文的非空白字符盈余阈值
ALIGN_ATTRIBUTES: dict[str, set[str]] = {}   # 同名新标签的这些属性取旧侧；优先于保留规则
CONTEXT_ATTRIBUTES: dict[str, set[str]] = {'*': {'style'}}  # 旧标签允许保留的新属性
ANCHOR_ID_PATTERN: str | None = r'S.*'       # 所有标签 id、a 的 name；None 不限制
LINK_HREF_PATTERN: str | None = r'#S.*'      # a 的 href；任一目标属性 fullmatch 即命中
RESTORE_MISSING_ANCHORS = True
RESTORE_PAGE_END_HYPHEN = True
REPLACE_TITLE = False               # True 整个 title 取旧侧；False 保留新侧
RESTORE_BRACKETS = True             # 尖括号/方括号；等价尖括号保留新侧拼写
REPORT_EDITS = True                 # 报告输出完整 diffplan 取值索引
REVIEW_CONTEXT_CHARS = 160

VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input",
             "link", "meta", "param", "source", "track", "wbr"}
HTML_TAGS = VOID_TAGS | set(('html head body title style script noscript template slot main section nav article aside header footer address '
    'div p blockquote pre h1 h2 h3 h4 h5 h6 hgroup ol ul menu li dl dt dd figure figcaption '
    'a em strong small s cite q dfn abbr ruby rt rp data time code var samp kbd sub sup i b u mark bdi bdo span ins del '
    'picture audio video map object iframe canvas table caption colgroup tbody thead tfoot tr td th '
    'form label button select datalist optgroup option textarea output progress meter fieldset legend details summary dialog search '
    'svg math font center strike tt big acronym frame frameset noframes dir applet').split())
BRACKET_CANONICAL = str.maketrans('⟨〈‹⟩〉›', '<<<>>>')
CHARACTER_RE = re.compile(r'&(?:#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]+);|[<>⟨〈‹⟩〉›\[\]]')
TOKEN_RE = re.compile(
    r"(?P<opaque>^[ \t]*(?P<fence>`{3,}|~{3,})[^\r\n]*\r?\n"
    r".*?^[ \t]*(?P=fence)[ \t]*(?=\r?$)"
    r"|(?P<tick>`+)[^`\r\n].*?(?P=tick)(?!`)"
    r"|<!--.*?-->|<!\[CDATA\[.*?\]\]>"
    r"|(?P<rawopen><(?P<rawtag>script|style|textarea|title)\b(?:[^>\"']|\"[^\"]*\"|'[^']*')*>)"
    r".*?</(?P=rawtag)\s*>)"
    r"|(?P<tag><!DOCTYPE\b(?:[^>\"']|\"[^\"]*\"|'[^']*')*>"
    r"|</?(?P<tagname>[A-Za-z][\w:-]*)(?:[^<>\"']|\"[^\"]*\"|'[^']*')*>)",
    re.I | re.S | re.M,
)
ATTR_RE = re.compile(
    r"\s+(?P<name>[^\s=/>]+)(?:\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s>]+))?"
)

# 不可变取值片段：文件侧 + 原文件左闭右开字符区间。补丁只在规划阶段使用。
Slice = namedtuple('Slice', 'side start end')
Patch = namedtuple('Patch', 'start end slices')

@dataclass(frozen=True)
class DiffPlan:
    slices: tuple[Slice, ...]  # 输出顺序；不存替换字符串，也不存修改后的坐标
    text_diff: tuple = ()
    reference_tags: int = 0
    context_tags: int = 0
    reference_characters: int = 0
    reviews: tuple = ()
    applicable: bool = True

class ReviewError(ValueError):
    def __init__(self, reason, position=None, side='source', category='diff_errors', code='structure'):
        super().__init__(reason)
        self.position, self.side, self.category, self.code = position, side, category, code

class Reviews(dict):
    def add(self, reason, position=None, side='source', category='diff_errors', code='structure'):
        self.setdefault((category, code, position, side), ReviewError(reason, position, side, category, code))

class Tag(namedtuple('TagFields', 'start end position raw name kind parts', defaults=((),))):
    # parts = (小写属性名, 标签内起点, 终点, 解码值)，由 parse 一次生成。
    @property
    def key(self):
        value = unescape(self.raw).translate(BRACKET_CANONICAL) if self.kind == 'character' else ''
        return self.name, self.kind, value
    attributes = cached_property(lambda t: {name: value for name, _, _, value in t.parts})

@dataclass(frozen=True)
class Document:
    raw: str
    text: str
    tags: tuple[Tag, ...]
    closing: dict
    invalid: frozenset = frozenset()

    index = cached_property(lambda d: PositionIndex(d))
    by_start = property(lambda d: d.index.by_start)
    owners = property(lambda d: d.index.owners)
    actions = cached_property(lambda d: d.selection[0])
    blocks = cached_property(lambda d: d.selection[1])

    def slice(self, start, end):
        offset = self.index.text(start)
        tags = tuple(t._replace(start=t.start-start, end=t.end-start, position=t.position-offset)
                     for t in self.tags[bisect_right(self.index.ends, start):bisect_right(self.index.ends, end)])
        by_start = {t.start: t for t in tags}
        closing = {t.start: by_start[closing_tag.start-start] for t in tags
                   if (closing_tag := self.closing.get(t.start+start)) and closing_tag.start-start in by_start}
        return Document(self.raw[start:end], self.text[offset:self.index.text(end)], tags, closing,
                        frozenset(t.start for t in tags if t.start+start in self.invalid))

    @cached_property
    def selection(self):
        actions, blocks = {}, []
        patterns = [re.compile(p) if p is not None else None for p in (ANCHOR_ID_PATTERN, LINK_HREF_PATTERN)]
        for tag in self.tags:
            end = self.closing.get(tag.start)
            if tag.name in REVIEW_ONLY_TAGS and tag.kind in {'open', 'void'}:
                blocks.append((tag, end.end if end else tag.end if tag.kind == 'void' else len(self.raw),
                               end.position if end else tag.position if tag.kind == 'void' else len(self.text),
                               self.raw[tag.end:end.start] if end else '' if tag.kind == 'void' else None))
            if tag.start in actions:
                continue
            action = ('take' if tag.kind == 'character' or FORMAT_TAGS is None or tag.name in FORMAT_TAGS else
                      'keep' if tag.name not in CONTEXT_EXCLUDED_TAGS and ('*' in CONTEXT_TAGS or tag.name in CONTEXT_TAGS) else 'drop')
            attrs = tag.attributes
            if tag.name == 'a' or 'id' in attrs:
                if tag.kind == 'close' or tag.kind == 'open' and end is None:
                    action = 'skip'
                else:
                    targets = [(patterns[k == 'href'], attrs[k]) for k in (('id', 'name', 'href') if tag.name == 'a' else ('id',)) if k in attrs]
                    if targets:
                        action = 'skip' if not any(p is None or p.fullmatch(v) for p, v in targets) else 'take' if RESTORE_MISSING_ANCHORS else action
                    if end:
                        actions[end.start] = action
            actions[tag.start] = action
        return actions, blocks

class PositionIndex:
    def __init__(self, document):
        self.by_start = {t.start: t for t in document.tags}
        self.closing = document.closing
        self.owners = {b.start: a for a, b in self.closing.items()}
        self.ends, self.positions, self.prefix, self.groups, self.candidates = [], [], [0], {}, defaultdict(lambda: ([], []))
        self.boundaries = {}
        for t in document.tags:
            self.boundaries.setdefault(t.position, t.start)
            if t.kind == 'close' and self.boundaries[t.position] == t.start:
                self.boundaries[t.position] = t.end
            self.ends.append(t.end)
            self.positions.append(t.position)
            self.prefix.append(self.prefix[-1] + t.end-t.start)
            self.groups.setdefault(t.position, [t.start, t.end])[1] = t.end
            positions, starts = self.candidates[t.key]
            positions.append(t.position)
            starts.append(t.start)
    def matching(self, key, left, right):
        positions, starts = self.candidates.get(key, ((), ()))
        return (self.by_start[s] for s in starts[bisect_left(positions, left):bisect_right(positions, right)])
    def text(self, raw):
        return raw-self.prefix[bisect_right(self.ends, raw)]
    def raw(self, position):
        return position+self.prefix[bisect_left(self.positions, position)]
    def span(self, document, start, end):
        left = self.boundaries[start] if start in self.boundaries else self.raw(start)
        right = self.boundaries[end] if end in self.boundaries else self.raw(end)
        return left, max(left, right)


def parse(source: str, characters=False) -> Document:
    """一次词法扫描、一次元素配对；属性和原始字符区间留给所有后续阶段复用。"""
    spans, protected, attr_starts = [], [], {}
    tokens = list(TOKEN_RE.finditer(source))
    closing_names = {m['tagname'].lower() for m in tokens if m.group('tag') and m[0].startswith('</')}
    for m in tokens:
        raw = m[0]
        if m.group('tag'):
            name = m['tagname'].lower() if m['tagname'] else '!doctype'
            if name not in HTML_TAGS and name not in closing_names and not raw.startswith('</') and not raw.endswith('/>') and '=' not in raw:
                continue
            kind = 'void' if name in VOID_TAGS or name == '!doctype' or raw.endswith('/>') else 'close' if raw.startswith('</') else 'open'
            spans.append((m.start(), m.end(), name, kind))
            if m['tagname']:
                attr_starts[m.start()] = m.end('tagname')-m.start()
        elif m.group('rawtag'):
            left, right, name = m.end('rawopen'), m.start()+raw.rfind('</'), m.group('rawtag').lower()
            spans.extend(((m.start(), left, name, 'open'), (right, m.end(), name, 'close')))
            attr_starts[m.start()] = m.end('rawtag')-m.start()
            protected.append((left, right))
        else:
            protected.append((m.start(), m.end()))
    # 只在已识别的标签/opaque 区间之外识别可迁移字符，不二次扫描标签。
    excluded = sorted([(a, b) for a, b, _, _ in spans] + protected)
    if characters and RESTORE_BRACKETS:
        cursor = 0
        for a, b in excluded + [(len(source), len(source))]:
            spans.extend((m.start(), m.end(), '#character', 'character') for m in CHARACTER_RE.finditer(source, cursor, a)
                         if unescape(m[0]) in '<>⟨〈‹⟩〉›[]')
            cursor = max(cursor, b)
    # 元素只配对一次；先定位页尾字符，再一次性建立所有正文坐标。
    spans.sort()
    stacks, pairs, tail = defaultdict(list), {}, None
    for a, b, name, kind in spans:
        if kind == 'open':
            stacks[name].append((a, b))
        elif kind == 'close' and stacks[name]:
            start, inner = stacks[name].pop()
            pairs[start] = a
            if name in {'p', 'blockquote'}:
                tail = inner, a
    if characters and RESTORE_PAGE_END_HYPHEN and tail:
        inner, offset = tail
        ends = {b: a for a, b, _, _ in spans}
        while offset > inner:
            if source[offset-1].isspace():
                offset -= 1
            elif offset in ends:
                offset = ends[offset]
            else:
                break
        if source[offset-1:offset] == '-' and not any(a <= offset-1 < b for a, b in protected):
            at = bisect_left([a for a, _, _, _ in spans], offset-1)
            spans.insert(at, (offset-1, offset, '#character', 'character'))
    tags, text, cursor, length = [], [], 0, 0
    for a, b, name, kind in spans:
        text.append(source[cursor:a])
        length += a-cursor
        raw, parts = source[a:b], []
        attribute_start = attr_starts.get(a)
        attributes = ATTR_RE.finditer(raw, attribute_start, len(raw)-(2 if raw.endswith('/>') else 1)) if attribute_start is not None and kind != 'close' else ()
        for m in attributes:
            value = m[0].partition('=')[2].strip()
            parts.append((m['name'].lower(), m.start(), m.end(), unescape(value[1:-1] if value[:1] in {'"', "'"} and value[-1:] == value[:1] else value)))
        tags.append(Tag(a, b, length, raw, name, kind, tuple(parts)))
        cursor = b
    by_start = {t.start: t for t in tags}
    return Document(source, ''.join((*text, source[cursor:])), tuple(tags), {a: by_start[b] for a, b in pairs.items()})


def inspect_document(document, side, reviews):
    pairs, tags, invalid, stack, ids, singles = document.closing, document.by_start, set(), [], {}, set()
    def issue(tag, reason, code):
        reviews.add(reason, tag.start, side, 'warnings' if code == 'duplicate_id' else 'parse_errors', code)
        if code in {'unclosed', 'unopened', 'crossing', 'nested_link', 'region'}: invalid.add(tag.start)
    for t in document.tags:
        if t.kind in {'open', 'void'}:
            for name, count in Counter(p[0] for p in t.parts).items():
                if count > 1: issue(t, f'重复属性 {name}：{t.raw}', 'attribute:'+name)
            identifier = t.attributes.get('id')
            if identifier:
                if identifier in ids: issue(t, f'id={identifier!r} 重复，首次位于字符 {ids[identifier]}', 'duplicate_id')
                ids.setdefault(identifier, t.start)
        if t.kind == 'open':
            if t.name in {'html', 'head', 'body', 'title'}:
                if t.name in singles or t.name == 'head' and 'body' in singles: issue(t, '区域重复或次序错误', 'region')
                singles.add(t.name)
            if t.name in {'head', 'body'} and any(tags[a].name in {'head', 'body'} for a in stack): issue(t, 'head/body 区域互相嵌套', 'region')
            if t.start not in pairs:
                issue(t, f'缺少 </{t.name}>：{t.raw}', 'unclosed')
                continue
            if t.name == 'a' and any(tags[a].name == 'a' for a in stack): issue(t, '原文 a 链接嵌套', 'nested_link')
            stack.append(t.start)
        elif t.kind == 'close':
            owner = document.owners.get(t.start)
            if owner is None: issue(t, f'缺少 <{t.name}>：{t.raw}', 'unopened')
            elif owner in stack:
                inside = stack[stack.index(owner)+1:]
                if inside and owner not in invalid:
                    issue(t, f'{t.raw} 与 {tags[inside[-1]].raw} 交叉', 'crossing')
                    invalid.update([owner, *inside])
                stack.remove(owner)
    invalid.update(pairs[a].start for a in tuple(invalid) if a in pairs)
    object.__setattr__(document, 'invalid', frozenset(invalid))
    return document

class TextDiff:
    """一次正文对齐，复用反向映射与已配对标签对未配对边界的约束。"""
    def __init__(self, old, new, opcodes):
        self.opcodes, self.old_length, self.new_length = tuple(opcodes), len(old), len(new)
        self.tags, self.tag_starts, self.tag_positions = {}, [], [0, len(new)]
        self.spans = [op for op in self.opcodes if op[2] > op[1]]
        self.starts = [op[1] for op in self.spans]
        self.opcode_ends, self.opcode_starts = [op[2] for op in self.opcodes], [op[1] for op in self.opcodes]
        self.edges = {p: q for _, a, b, c, d in self.opcodes for p, q in ((a, c), (b, d))}
        self.edges.update({0: 0, len(old): len(new)} if old else {0: 0})
        self._bounds = {}
    def map(self, position, tag_start=None):
        if position in self.edges:
            mapped = self.edges[position]
        else:
            kind, a, b, c, d = self.spans[bisect_right(self.starts, position) - 1]
            mapped = c + position - a if kind == 'equal' else d
        if tag_start is None:
            return mapped
        index = bisect_left(self.tag_starts, tag_start)
        return self.tag_positions[index + 1] if tag_start in self.tags else max(self.tag_positions[index], min(mapped, self.tag_positions[index + 1]))
    @cached_property
    def reversed(self):
        kinds = {'equal': 'equal', 'replace': 'replace', 'insert': 'delete', 'delete': 'insert'}
        return TextDiff(range(self.new_length), range(self.old_length), ((kinds[k], c, d, a, b) for k, a, b, c, d in self.opcodes))
    def reverse(self):
        return self.reversed
    def bounds(self, position):
        if position in self._bounds:
            return self._bounds[position]
        spans = [(c + position - a,) * 2 if kind == 'equal' else (c, d)
                 for kind, a, b, c, d in self.opcodes[bisect_left(self.opcode_ends, position):bisect_right(self.opcode_starts, position)]]
        self._bounds[position] = (min(c for c, _ in spans), max(d for _, d in spans)) if spans else (self.map(position),) * 2
        return self._bounds[position]
    def span(self, start, end):
        spans = [(c + max(start, a) - a, c + min(end, b) - a) if kind == 'equal' else (c, d)
                 for kind, a, b, c, d in self.opcodes[bisect_right(self.opcode_ends, start):bisect_left(self.opcode_starts, end)]
                 if a < end and (b > start or a == b and start < a)]
        return (min(self.map(start), *(a for a, _ in spans)), max(self.map(end), *(b for _, b in spans))) if spans else (self.map(start), self.map(end))

def align_parts(parts):
    """一次正文 diff；标签对应由差异区间坐标和元素起止关系决定。"""
    streams = [[], []]
    for region, pair in enumerate(parts):
        if pair[0].text == pair[1].text:
            continue
        for stream, document in zip(streams, pair):
            stream.extend(((region, 'text', unescape(m[0]) if m[0].startswith('&') else m[0]), m.start(), m.end())
                          for m in re.finditer(r'&(?:\#\w+|\w+);|[^\s]', document.text))
            stream.append(((region, 'boundary'), len(document.text), len(document.text)))
    # token 等值编码为单个字符；最长匹配交给原生 find，避免重复 token 的 Python 候选矩阵。
    codes = {key: chr(i) for i, key in enumerate(dict.fromkeys(item[0] for stream in streams for item in stream))}
    encoded_a, encoded_b = (''.join(codes[item[0]] for item in stream) for stream in streams)
    junk, present = {codes[key] for key in codes if key[1] == 'boundary'}, set(encoded_b)
    # 对侧不存在的 token 不可能匹配，切开后不再搜索跨越这些位置的片段。
    boundaries = [i for i, char in enumerate(encoded_a) if char in junk or char not in present]
    def longest(alo, ahi, blo, bhi):
        besti, bestj, size, left = alo, blo, 0, alo
        for stop in boundaries[bisect_left(boundaries, alo):bisect_left(boundaries, ahi)] + [ahi]:
            for i in range(left, stop):
                if i+size >= stop: break
                found = encoded_b.find(encoded_a[i:i + size + 1], blo, bhi)
                if found < 0: continue
                low, high = size + 1, min(stop - i, bhi - blo) + 1
                while low + 1 < high:
                    middle = (low + high) // 2
                    candidate = encoded_b.find(encoded_a[i:i + middle], found, bhi)
                    if candidate < 0: high = middle
                    else: low, found = middle, candidate
                besti, bestj, size = i, found, low
            left = stop + 1
        return besti, bestj, size
    if encoded_a == encoded_b:
        matches = [(0, 0, len(encoded_a))]
    else:
        matcher = SequenceMatcher(junk.__contains__, encoded_a, encoded_b, autojunk=False)
        matcher.find_longest_match = longest
        matches = matcher.get_matching_blocks()
    equals = [[] for _ in parts]
    for a, b, size in matches:
        for (key, i, j), (_, k, l) in zip(streams[0][a:a+size], streams[1][b:b+size]):
            region = key[0]
            if i == j or parts[region][0].text[i:j] != parts[region][1].text[k:l]:
                continue
            if equals[region]:
                x, previous_i, y, previous_k = equals[region][-1]
                if parts[region][0].text[previous_i:i] == parts[region][1].text[previous_k:k]:
                    equals[region][-1] = x, j, y, l
                    continue
            equals[region].append((i, j, k, l))
    result = []
    for (old_document, new_document), ranges in zip(parts, equals):
        old_text, new_text = old_document.text, new_document.text
        if old_text == new_text: ranges = [(0, len(old_text), 0, len(new_text))]
        ops, a, c = [], 0, 0
        def emit(kind, x, y, u, v):
            if x == y and u == v: return
            if ops and ops[-1][0] == kind and ops[-1][2] == x and ops[-1][4] == u:
                _, x, _, u, _ = ops.pop()
            ops.append((kind, x, y, u, v))
        for i, j, k, l in ranges+[(len(old_text), len(old_text), len(new_text), len(new_text))]:
            # equal token 之间只收紧共同的空白前后缀，不再次 diff。
            prefix = commonprefix((old_text[a:i], new_text[c:k]))
            lead = len(prefix)-len(prefix.lstrip())
            suffix = commonprefix((old_text[a+lead:i][::-1], new_text[c+lead:k][::-1]))
            tail = len(suffix)-len(suffix.lstrip())
            emit('equal', a, a+lead, c, c+lead)
            x, y, u, v = a+lead, i-tail, c+lead, k-tail
            emit('replace' if x < y and u < v else 'delete' if x < y else 'insert', x, y, u, v)
            emit('equal', i-tail, j, k-tail, l)
            a, c = j, l
        mapping = TextDiff(old_document.text, new_document.text, ops)
        paired, parents, previous = {}, [], -1
        for tag in old_document.tags:
            while parents and parents[-1][0] <= tag.start: parents.pop()
            if tag.start in paired:
                previous = paired[tag.start]
                continue
            if tag.kind == 'close': continue   # 闭合只跟随已经对应的开始标签
            left, right = mapping.bounds(tag.position)
            while left > 0 and new_text[left-1].isspace(): left -= 1
            while right < len(new_text) and new_text[right].isspace(): right += 1
            end, candidates = old_document.closing.get(tag.start), []
            end_left, end_right = mapping.bounds(end.position) if end else (left, right)
            limit = parents[-1][1] if parents else float('inf')
            for target in new_document.index.matching(tag.key, left, right):
                finish = new_document.closing.get(target.start)
                if target.start <= previous or target.start >= limit or bool(end) != bool(finish): continue
                whole = not finish or finish.start < limit and (end_left <= finish.position <= end_right
                        or not new_text[min(end_left, finish.position):max(end_right, finish.position)].strip())
                if whole or left == right: candidates.append((target, finish, whole))
                if whole: break
            if not candidates: continue
            target, finish, whole = next((item for item in candidates if item[2]), candidates[0])
            paired[tag.start] = previous = target.start
            if finish and whole:
                paired[end.start] = finish.start
                parents.append((end.start, finish.start))
        mapping.tags, mapping.tag_starts = (ordered := dict(sorted(paired.items()))), list(ordered)
        mapping.tag_positions = [0, *(new_document.by_start[start].position for start in mapping.tags.values()), len(new_document.text)]
        result.append(mapping)
    return result
def tag_slices(tag, counterpart, side, retain=False):
    """属性覆盖也只引用两侧原文；标签尾部和属性之间的空白沿用原始区间。"""
    aligned = ALIGN_ATTRIBUTES.get('*', set()) | ALIGN_ATTRIBUTES.get(tag.name, set())
    names = (CONTEXT_ATTRIBUTES.get('*', set()) | CONTEXT_ATTRIBUTES.get(tag.name, set()))-aligned if retain else aligned
    incoming = [p for p in counterpart.parts if p[0] in names] if counterpart else []
    removed = {p[0] for p in incoming} if retain else names
    cursor, result = tag.start, []
    for name, a, b, _ in tag.parts:
        if name in removed:
            result.append(Slice(side, cursor, tag.start+a))
            cursor = tag.start+b
    end = tag.end-(2 if tag.raw.endswith('/>') else 1) if incoming else tag.end
    result.append(Slice(side, cursor, end))
    result.extend(Slice('source' if side == 'reference' else 'reference', counterpart.start+a, counterpart.start+b) for _, a, b, _ in incoming)
    if end < tag.end: result.append(Slice(side, end, tag.end))
    return tuple(result)

def record_positions(length, patches):
    """把所有标签、字符和空白补丁一次转换为输出顺序的取值索引。"""
    result, cursor = [], 0
    for patch in sorted(patches, key=lambda p: (p.start, p.end)):
        if not cursor <= patch.start <= patch.end <= length:
            raise ValueError('计划区间越界、倒序或重叠')
        result.extend((Slice('source', cursor, patch.start), *patch.slices))
        cursor = patch.end
    result.append(Slice('source', cursor, length))
    compact = []
    for s in result:
        if s.start == s.end: continue
        if compact and compact[-1].side == s.side and compact[-1].end == s.start:
            compact[-1] = Slice(s.side, compact[-1].start, s.end)
        else: compact.append(s)
    return tuple(compact)

def apply_plan(source: str, reference: str, plan: DiffPlan) -> str:
    texts, output = {'source': source, 'reference': reference}, []
    for s in plan.slices:
        if s.side not in texts or not 0 <= s.start <= s.end <= len(texts[s.side]):
            raise ValueError('取值索引的文件侧或区间无效')
        output.append(texts[s.side][s.start:s.end])
    result = ''.join(output)
    result = re.sub(r"(</p\s*>)\s+(</blockquote\s*>)", r"\1\2", result, flags=re.I)
    result = re.sub(r"(<blockquote\b[^>]*>)\s+(<p\b[^>]*>)", r"\1\2", result, flags=re.I)
    result = re.sub(r"(?:\r?\n){2,}[ \t\r\n]*(?=<blockquote\b)",
                    '\r\n' if '\r\n' in source else '\n', result, flags=re.I)
    result = re.sub(r"(?<=</blockquote>)[ \t\r\n]*(?:\r?\n){2,}[ \t\r\n]*",
                '\r\n' if '\r\n' in source else '\n', result, flags=re.I)
    return result

def whitespace_edits(new, old, alignment, selected, reviews):
    """统一规划标签间空白的携带、补入、删除和去重；换行沿用新侧 LF/CRLF。"""
    source, mapping = new.raw, alignment.tags
    ending = re.search(r'\r\n|\n', source)
    newline = Slice('source', ending.start(), ending.end()) if ending else None
    padding, carried, positions = set(), set(), set()

    def run(text, position):
        left = right = position
        while left > 0 and text[left-1] in ' \t\r\n': left -= 1
        while right < len(text) and text[right] in ' \t\r\n': right += 1
        return left, right, text[left:right]

    def patch(a, b, c, d, remove=False):
        before, after = source[a:b], old.raw[c:d]
        if before == after or not remove and ('\n' in before) == ('\n' in after): return None
        if remove: return Patch(a, b, ())
        if '\n' not in after:  # 只有删除新侧换行时，才补回旧侧空格或制表符。
            return Patch(a, b, (Slice('reference', c, d),))
        slices = tuple(newline or Slice('reference', c+m.start(), c+m.end())
                       for m in re.finditer(r'\r\n|\n', after))
        return Patch(a, b, (*slices, Slice('source', a, b)))

    groups, pairs_by_position, tags_by_position = new.index.groups, defaultdict(list), defaultdict(list)
    preceding = {tag.end: tag.start for tag in old.tags}
    kept = {tag.start for _, tag, _, _ in selected[1]}
    for i, (position, tag, raw, order) in enumerate(selected[0]):
        counterpart = new.by_start.get(mapping.get(tag.start))
        tags_by_position[position].append(tag)
        if counterpart:
            pairs_by_position[position].append((tag, counterpart))
            kept.add(counterpart.start)
            if new.actions[counterpart.start] == 'skip': counterpart = None
        if tag.kind == 'character': continue  # 实体、括号和连字符是正文，不是 HTML 标签。
        positions.add(position)
        for before in (True, False):
            left, right, space = run(old.raw, tag.start if before else tag.end)
            if '\n' not in space or (left, right) in carried: continue
            neighbor = new.by_start.get(mapping.get(preceding.get(left) if before else right))
            start, end, _ = run(new.text, position)
            if not (groups[position][0] < (counterpart.start if before else counterpart.end) < groups[position][1] if counterpart else
                    '\n' not in (new.text[start:position] if before else new.text[position:end]) or neighbor is not None and neighbor.position == position): continue
            pieces = patch(0, 0, left, right).slices
            raw = pieces + raw if before else raw + pieces
            carried.add((left, right))
            if counterpart is None: padding.add(position)
        selected[0][i] = position, tag, raw, order
    desired = merge_tag_streams(selected, [old, new], reviews)
    positions.update(t.position for t in new.tags if t.start not in kept and t.kind != 'character')
    boundaries = sorted(groups.keys() | desired.keys())
    edits = [Patch(*(groups[p] if p in groups else (new.index.raw(p),)*2), desired.get(p, ())) for p in boundaries]
    seen, reverse, padding_positions = set(), alignment.reverse(), sorted(padding)
    # 已配对标签先确定空白关系，未配对标签的反向投影不能覆盖同一段空白。
    for position in sorted(positions | padding, key=lambda p: (p not in pairs_by_position, p)):
        for tag, counterpart in pairs_by_position.get(position) or [(None, None)]:
            for before in (True, False) if tag else (True,):
                if tag:
                    a, b, new_ws = run(source, counterpart.start if before else counterpart.end)
                    # 标签簇外的换行属于最终最外侧标签，不能按内层 p 的空白删掉。
                    edge = groups[position][0 if before else 1]
                    boundary_tag = tags_by_position[position][0 if before else -1] if (counterpart.start if before else counterpart.end) == edge else tag
                    c, d, old_ws = run(old.raw, boundary_tag.start if before else boundary_tag.end)
                else:
                    left, right, new_ws = run(new.text, position)
                    left_old, right_old, old_ws = run(old.text, reverse.map(position))
                    c, d = old.index.raw(left_old), old.index.raw(right_old)
                    if old.raw[c:d] != old_ws: continue
                    a, b = (groups[p][end] if p in groups else new.index.raw(p) for p, end in ((left, 1), (right, 0)))
                if tag and bisect_left(boundaries, new.index.text(b)) > bisect_right(boundaries, new.index.text(a)): continue
                # 拆分标签已携带旧侧换行时，删掉该空白段，避免误合行空格残留或重复换行。
                carried_ws = (bool(new_ws) or tag is None) and '\n' not in new_ws and bisect_left(padding_positions, new.index.text(a)) < bisect_right(padding_positions, new.index.text(b))
                if a > b or (a, b) in seen or tag and source[a:b] != new_ws: continue
                overlaps = [e for e in edits if a < e.end and b > e.start or a < e.start < b]
                if overlaps and (tag or any(e.slices or e.start < a or e.end > b for e in overlaps)): continue
                seen.add((a, b))
                if (edit := patch(a, b, c, d, carried_ws)) is not None:
                    # 空白段中仅有待删标签时，一次删除这些标签和错误换行，再补旧侧空格。
                    edits = [e for e in edits if e not in overlaps]
                    edits.append(edit)
    return edits

def merge_tag_streams(streams, documents, reviews):
    """保持两侧顺序和元素身份，按范围开外层、按实际栈关闭内层。"""
    ends, owners, cursors, stack, desired = {}, {}, [0, 0], [], defaultdict(list)
    invalid = [d.invalid for d in documents]
    for side, stream in enumerate(streams):
        closing_pairs = documents[side].closing
        indices = {tag.start: i for i, (_, tag, _, _) in enumerate(stream)}
        for i, (position, tag, raw, _) in enumerate(stream):
            end = closing_pairs.get(tag.start)
            end = end if end and end.start in indices else None
            if tag.kind == 'open':
                ends[side, i] = stream[indices[end.start]][0] if end else position
                if end:
                    owners[side, indices[end.start]] = (side, i)
            if tag.start not in invalid[side] and ((tag.kind == 'open' and end is None) or (tag.kind == 'close' and (side, i) not in owners)):
                reviews.add(f'筛选破坏了标签配对：{tag.raw}', tag.start,
                            'reference' if side == 0 else 'source', code='selection')
    owners = {key: owner for key, owner in owners.items() if streams[owner[0]][owner[1]][1].start not in invalid[owner[0]]}
    paired = set(owners.values())
    while any(cursor < len(stream) for cursor, stream in zip(cursors, streams)):
        heads = [(side, cursor) for side, cursor in enumerate(cursors) if cursor < len(streams[side])]
        position = min(streams[side][i][0] for side, i in heads)
        heads = [key for key in heads if streams[key[0]][key[1]][0] == position]
        constrained, top = None, stack[-1] if stack else None
        if len(heads) == 2:
            for left, right in zip(*(streams[side][i][3] for side, i in heads)):
                if left is not None and right is not None and left != right:
                    constrained = [heads[left > right]]
                    break
        closing_heads = [key for key in heads if top and key[0] == top[0] and ends[top] == position]
        crossing = [key for key in heads if owners.get(key) in stack
                    and any(ends[inner] > position for inner in stack[stack.index(owners[key]) + 1:])]
        candidates = constrained or closing_heads or crossing or [key for key in heads if streams[key[0]][key[1]][1].kind != 'close'] or heads
        empty = any(ends.get(key, position) == position for key in candidates)
        side, index = key = min(candidates, key=lambda k: (0 if empty else -ends.get(k, position), k[0]))
        _, tag, raw, _ = streams[side][index]
        if tag.kind == 'open' and key in paired:
            if tag.name == 'a' and any(streams[s][i][1].name == 'a' for s, i in stack):
                reviews.add('合并导致 a 链接嵌套', tag.start, 'reference' if side == 0 else 'source', code='nested_link')
            stack.append(key)
        elif tag.kind == 'close' and (owner := owners.get(key)) in stack:
            if stack[-1] != owner:
                opening, inner = streams[owner[0]][owner[1]][1], streams[stack[-1][0]][stack[-1][1]][1]
                reviews.add(f'合并导致 {opening.tag.raw} 与 {inner.tag.raw} 交叉', opening.start,
                            'reference' if side == 0 else 'source', code='crossing')
            stack.remove(owner)
        desired[position].append(raw)
        cursors[side] += 1
    return {position: tuple(s for pieces in raws for s in pieces) for position, raws in desired.items()}

def protected_ranges(new: Document, old: Document, alignment: TextDiff, reviews: Reviews):
    """先标记正文缺口，再标记差异块；只保护对应区间，不影响其余编辑。"""
    ranges, used = [[], []], set()             # 旧侧、新侧
    for kind, a, b, c, d in alignment.opcodes:
        if kind not in {'delete', 'replace'}:
            continue
        surplus = len(''.join(unescape(old.text[a:b]).split())) - len(''.join(unescape(new.text[c:d]).split()))
        if surplus >= TEXT_GAP_MIN_CHARS:
            for target, prepared, left, right in ((ranges[0], old, a, b), (ranges[1], new, c, d)):
                target.append(prepared.index.span(prepared, left, right))
            reviews.add(f'旧侧未匹配正文比新侧多 {surplus} 个非空白字符，已跳过对应片段的格式替换', ranges[0][-1][0], 'reference', code='text_gap')
    boundary_start = len(ranges[0])
    for side, prepared, target, mapping in ((0, old, new, alignment), (1, new, old, alignment.reverse())):
        for index, (opening, end, finish, content) in enumerate(prepared.blocks):
            if side == 1 and index in used:
                continue
            left, right = mapping.span(opening.position, finish)
            counterpart = min(((i, block) for i, block in enumerate(target.blocks) if i not in used and block[0].name == opening.name
                               and (alignment.tags.get(opening.start) == block[0].start or block[0].position == left and block[2] == right
                                    or block[0].position < right and block[2] > left)),
                              key=lambda item: abs(item[1][0].position - left), default=None) if side == 0 else None
            other_range = target.index.span(target, left, right)
            if counterpart:
                matched, block = counterpart
                used.add(matched)
                if content is not None and content == block[3]:
                    continue
                other_range = min(block[0].start, other_range[0]), max(block[1], other_range[1])
            ranges[side].append((opening.start, end))
            ranges[1 - side].append(other_range)
            if content is not None and (not counterpart or block[3] is not None):
                reviews.add(f'<{opening.name}> 内容不同或缺少对应块，块边界按旧侧对齐，内部行内格式保留新侧',
                            opening.start, 'reference' if side == 0 else 'source', 'warnings', 'protected_block')
    return ranges, boundary_start

BLOCK_TAGS = {'p', 'blockquote', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'}
TABLE_TAGS = {'caption', 'colgroup', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th'}

def protect_tags(document, ranges, boundary_start, boundaries, boundary_tags, side):
    """按元素整对计算保护策略，开始和结束标签共享一次判断。"""
    decisions, ordered_ranges = {}, list(enumerate(ranges))[::-1]
    for tag in document.tags if ranges else ():
        if tag.start in document.owners:
            continue
        finish = document.closing.get(tag.start, tag)
        for index, (start, end) in ordered_ranges:
            # 文档区域不是保护块的边界，不能因包住多个块而改成 take/drop。
            if index >= boundary_start and tag.name in {'html', 'head', 'body', 'title'}:
                continue
            if not (tag.start < end and finish.end > start or start == end == tag.start):
                continue
            crossing = tag.kind == 'open' and (tag.start < start < finish.end <= end or start <= tag.start < end < finish.end)
            spans_blocks = side == 1 and bisect_right(boundaries, tag.position) < bisect_left(boundaries, finish.position)
            if index >= boundary_start and (tag.name in boundary_tags or crossing or spans_blocks):
                decisions[tag.start] = None   # 块边界对齐旧侧
            elif index < boundary_start or start <= tag.start and finish.end <= end:
                decisions[tag.start] = (index, start, end)
            break
    protected = {tag.start: decisions[owner] for tag in document.tags if (owner := document.owners.get(tag.start, tag.start)) in decisions}
    document.actions.update((start, 'take' if side == 0 else 'drop') for start, policy in protected.items() if policy is None)
    return protected

def equivalent_quotes(new, old, alignment, boundary_tags):
    for start, target in alignment.tags.items():
        q = old.by_start[start]
        if q.name != 'blockquote' or q.kind != 'open' or start not in old.closing or target not in new.closing: continue
        if alignment.tags.get(old.closing[start].start) != new.closing[target].start: continue
        pairs = []
        for doc, opening in ((old, q), (new, new.by_start[target])):
            end = doc.closing[opening.start]
            tags = [t for t in doc.tags[bisect_right(doc.index.ends, opening.end):bisect_right(doc.index.ends, end.start)] if t.name in boundary_tags]
            pairs.append((doc, opening, end, tags))
        if sorted(len(ts) for _, _, _, ts in pairs) != [0, 2]: continue
        if any(ts and (ts[0].name != 'p' or doc.closing.get(ts[0].start) != ts[1] or ts[0].parts
                      or doc.raw[q.end:ts[0].start].strip() or doc.raw[ts[1].end:end.start].strip()
                      or any(t.start in doc.invalid for t in ts)) for doc, q, end, ts in pairs): continue
        for doc, q, end, ts in pairs:
            doc.actions.update((t.start, 'drop' if doc is old else 'keep') for t in (*ts, q, end))

def _diff_fragment(source, new, old, alignment):
    reviews = Reviews()
    ranges, boundary_start = protected_ranges(new, old, alignment, reviews)
    boundary_tags = BLOCK_TAGS | REVIEW_ONLY_TAGS | TABLE_TAGS
    boundaries = sorted({alignment.map(t.position, t.start) for t in old.tags if t.name in boundary_tags})
    mappings = [alignment.tags, {target: start for start, target in alignment.tags.items()}]
    selected, prepared = [[], []], [old, new]
    equivalent_quotes(new, old, alignment, boundary_tags)
    new_hyphen = any(t.kind == 'character' and t.raw == '-' for t in new.tags)
    # 两侧保护策略先确定，属性覆盖和 skip 判断共享这些取舍。
    policies = [protect_tags(own, ranges[side], boundary_start, boundaries, boundary_tags, side)
                for side, own in enumerate(prepared)]
    for side, own in enumerate(prepared):
        other, mapping = prepared[1 - side], mappings[side]
        for tag in own.tags:
            action, preserve = own.actions.get(tag.start), policies[side].get(tag.start)
            hyphen = tag.kind == 'character' and tag.raw == '-'
            position = tag.position if side else alignment.map(tag.position, tag.start)
            if side == 0 and (preserve or hyphen and (new_hyphen or new.text[:position].rstrip().endswith('-'))):
                continue
            if not (action == 'take' if side == 0 else preserve or action in {'keep', 'skip'} or hyphen):
                continue
            counterpart = other.by_start.get(mapping.get(tag.start))
            if side == 0 and tag.start not in policies[side] and counterpart:
                position = counterpart.position
            if counterpart and other.actions[counterpart.start] == 'skip':
                counterpart = None
            if preserve or side == 1 and action == 'skip':
                raw = (Slice('source' if side else 'reference', tag.start, tag.end),)
            elif side == 0 and tag.kind == 'character':
                raw = (Slice('source', counterpart.start, counterpart.end),) if counterpart and counterpart.raw not in {'<', '>'} else (Slice('reference', tag.start, tag.end),)
            else:
                raw = tag_slices(tag, counterpart, 'source' if side else 'reference', retain=side == 0)
            if side == 0 and tag.kind == 'character' and tag.raw in {'<', '>'} and (not counterpart or counterpart.raw in {'<', '>'}):
                reviews.add('旧文件尖括号也未转义，请手动修复为 &lt; / &gt;', tag.start, 'reference', 'warnings', 'unescaped_angle')
            selected[side].append((position, tag, raw, (mapping.get(tag.start), tag.start) if side else (tag.start, mapping.get(tag.start))))
    edits = whitespace_edits(new, old, alignment, selected, reviews)
    characters = sum(t.kind == 'character' for _, t, _, _ in selected[0])
    return edits, (len(selected[0])-characters, len(selected[1]), characters), tuple(reviews.values())

def diff(source: str, reference: str) -> DiffPlan:
    """两侧各解析一次；只对需要格式迁移的分区执行一次正文 diff。"""
    reviews, sections, patches = Reviews(), [], []
    new, old = (inspect_document(parse(raw, characters=True), side, reviews)
                for raw, side in ((source, 'source'), (reference, 'reference')))
    def blocked():
        return DiffPlan((Slice('source', 0, len(source)),), reviews=tuple(reviews.values()), applicable=False)
    if any(t.start in doc.invalid and t.name in {'html', 'head', 'body', 'title'} for doc in (new, old) for t in doc.tags):
        return blocked()
    def regions(doc, names, left=0, right=None):
        return {t.name: (t.start, t.end, end.start, end.end) for t in doc.tags
                if t.name in names and (end := doc.closing.get(t.start)) and t.start >= left and (right is None or end.end <= right)}
    def head(a, b, c, d):
        (ns, ne), (os, oe) = ((t[0], t[3]) if (t := regions(doc, {'title'}, start, end).get('title')) else (start, start)
                              for doc, start, end in ((new, a, b), (old, c, d)))
        sections.extend((('format', a, ns, c, os), ('title', ns, ne, os, oe), ('format', ne, b, oe, d)))
    nr, or_ = regions(new, {'head', 'body'}), regions(old, {'head', 'body'})
    if 'head' not in nr and 'head' not in or_:
        head(int(source.startswith('\ufeff')), len(source), int(reference.startswith('\ufeff')), len(reference))
    elif nr.keys() != or_.keys():
        reviews.add('两侧 head/body 缺少对应区域', code='regions')
        return blocked()
    else:
        for name, (a, inner, end, b) in sorted(nr.items(), key=lambda item: item[1][0]):
            c, old_inner, old_end, d = or_[name]
            if name == 'head':
                head(inner, end, old_inner, old_end)
            else:
                sections.append(('format', a, b, c, d))
    documents = [(new.slice(a, b), old.slice(c, d)) for mode, a, b, c, d in sections if mode == 'format']
    aligned = iter(zip(documents, align_parts([(o, n) for n, o in documents])))
    opcodes, counts = [], [0, 0, 0]
    for mode, a, b, c, d in sections:
        if mode == 'title':
            if REPLACE_TITLE:
                patches.append(Patch(a, b, (Slice('reference', c, d),)))
            continue
        (n, o), alignment = next(aligned)
        edits, chosen, issues = _diff_fragment(n.raw, n, o, alignment)
        offsets = {'source': a, 'reference': c}
        for e in edits:
            slices = tuple(Slice(s.side, s.start+offsets[s.side], s.end+offsets[s.side]) for s in e.slices)
            patches.append(Patch(e.start+a, e.end+a, slices))
        counts = [x+y for x, y in zip(counts, chosen)]
        opcodes.extend((kind, i+old.index.text(c), j+old.index.text(c), k+new.index.text(a), l+new.index.text(a)) for kind, i, j, k, l in alignment.opcodes)
        for e in issues:
            reviews.add(str(e), None if e.position is None else e.position+offsets[e.side], e.side, e.category, e.code)
    return DiffPlan(record_positions(len(source), patches), tuple(opcodes), *counts, tuple(reviews.values()))


def transfer(source: str, reference: str) -> tuple[str, int]:
    plan = diff(source, reference)
    return apply_plan(source, reference, plan), plan.reference_tags+plan.context_tags

transfer_formats = transfer

def issue_detail(error, texts):
    """仅保存一次原因和实际出错侧的原始位置，不伪造对侧映射位置。"""
    result = {'code': error.code, 'reason': str(error), 'side': error.side}
    if error.position is not None:
        text, offset = texts[error.side], error.position
        start, end = max(0, offset - REVIEW_CONTEXT_CHARS), min(len(text), offset + REVIEW_CONTEXT_CHARS)
        result.update(offset=offset, line=text.count('\n', 0, offset) + 1,
                      column=offset - text.rfind('\n', 0, offset), context={'start': start, 'end': end, 'text': text[start:end]})
    return result

def main() -> int:
    script_dir = Path(__file__).resolve().parent
    source, reference, output = ((script_dir / p).resolve() for p in (INPUT_DIR, REFERENCE_DIR, OUTPUT_DIR))
    if not source.is_dir() or not reference.is_dir():
        print("配置错误：输入和参照必须是已有目录")
        return 2
    if any(output.is_relative_to(p) or p.is_relative_to(output) for p in (source, reference)):
        print("配置错误：输出必须是独立新目录，不能与输入/参照相互包含")
        return 2
    output.mkdir(parents=True, exist_ok=True)
    report = []
    for path in sorted(p for p in source.rglob("*") if p.is_file() and p.suffix.lower() in EXTENSIONS):
        relative, data = path.relative_to(source), path.read_bytes()
        row, result = {'file': relative.as_posix()}, data
        if not (gold_path := reference / relative).is_file():
            row.update(status="MISSING_REFERENCE", reason="无同路径参照，原样复制")
        else:
            texts, errors, plan = {}, [], None
            for side, content in (('source', data), ('reference', gold_path.read_bytes())):
                try:
                    texts[side] = content.decode(ENCODING)
                except UnicodeError as exc:
                    errors.append(ReviewError(str(exc), side=side, category='parse_errors', code='encoding'))
            if not errors:
                try:
                    plan = diff(texts['source'], texts['reference'])
                    errors.extend(plan.reviews)
                    result = apply_plan(texts['source'], texts['reference'], plan).encode(ENCODING)
                except ValueError as exc:
                    errors.append(ReviewError(str(exc), code='plan'))
                    plan = None
            for error in errors:
                row.setdefault(error.category, []).append(issue_detail(error, texts))
            row.update(status='REVIEW' if row.get('parse_errors') or row.get('diff_errors') else 'WARNING' if row.get('warnings') else 'OK',
                       applied=plan is not None and plan.applicable, changed=result != data)
            if plan is not None:
                row.update((name, getattr(plan, name)) for name in ('reference_tags', 'context_tags', 'reference_characters'))
                if REPORT_EDITS:
                    row.update(diffplan=[s._asdict() for s in plan.slices], text_diff=[op for op in plan.text_diff if op[0] != 'equal'])
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(result)
        report.append(row)
    priority = {"REVIEW": 0, "MISSING_REFERENCE": 1, "WARNING": 2, "OK": 3}
    report.sort(key=lambda row: priority[row["status"]])
    summary = dict(Counter(row["status"] for row in report))
    names = ('FORMAT_TAGS CONTEXT_TAGS CONTEXT_EXCLUDED_TAGS REVIEW_ONLY_TAGS TEXT_GAP_MIN_CHARS ANCHOR_ID_PATTERN '
             'LINK_HREF_PATTERN RESTORE_MISSING_ANCHORS RESTORE_PAGE_END_HYPHEN RESTORE_BRACKETS '
             'REPLACE_TITLE CONTEXT_ATTRIBUTES ALIGN_ATTRIBUTES').split()
    rules = {'minus': str(reference), 'plus': str(source), **{name.lower(): globals()[name] for name in names}}
    (output / "_format_report.json").write_text(json.dumps({"rules": rules, "summary": summary, "files": report}, ensure_ascii=False, indent=2, default=sorted), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    print(f"输出：{output}")
    return int(any(row["status"] in {"REVIEW", "MISSING_REFERENCE"} for row in report))

if __name__ == "__main__":
    raise SystemExit(main())
