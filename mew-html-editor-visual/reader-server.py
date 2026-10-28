"""FastAPI translation of reader-server.js. Run with Python; requires fastapi and uvicorn."""
import argparse
import asyncio
from contextlib import asynccontextmanager
import json
import math
import os
from pathlib import Path
import queue
import re
import sys
import threading
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from starlette.concurrency import run_in_threadpool
import uvicorn
from urllib.parse import quote, unquote, urlsplit
from urllib.request import urlopen, url2pathname

HERE = Path(__file__).resolve().parent

SETTINGS_FILE = HERE / 'reader.settings.json'
MIME = {
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
    '.markdown': 'text/markdown; charset=utf-8', '.pdf': 'application/pdf',
    '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml'
}


def find_default_config(explicit=None):
    explicit = explicit or os.environ.get('CONFIG')
    if explicit:
        return Path(explicit).resolve()
    directory = Path.cwd().resolve()
    for parent in (directory, *directory.parents):
        for name in ('.mew-reader.json', 'mew-reader.json'):
            candidate = parent / name
            if candidate.exists():
                return candidate
    candidates = [HERE / '.mew-reader.json', HERE.parent / 'MEW_BRIEF/.mew-reader.json',
                  HERE.parent / 'MECW_reconv/.mew-reader.json']
    return next((file for file in candidates if file.exists()), candidates[0])


def inside(candidate, root):
    return candidate.resolve().is_relative_to(root.resolve())


def resource(raw, base):
    value = str(raw or '.')
    parsed = urlsplit(value)
    if parsed.scheme in ('http', 'https'):
        return dict(kind='url', path=value.rstrip('/'))
    if parsed.scheme == 'file':
        value = ('//' + parsed.netloc if parsed.netloc else '') + url2pathname(parsed.path)
    return dict(kind='file', path=(base / value).resolve())


def settings(value=None):
    value = value if isinstance(value, dict) else {}
    def color(name, fallback):
        item = str(value.get(name, ''))
        return item.lower() if re.fullmatch(r'#[0-9a-fA-F]{6}', item) else fallback
    try:
        brightness = float(value.get('brightness') or 100)
        if not math.isfinite(brightness):
            brightness = 100
    except (ValueError, TypeError):
        brightness = 100
    scale = value.get('scale')
    return dict(brightness=max(50, min(160, brightness)), paper=color('paper', '#ffffff'),
                ink=color('ink', '#000000'), invert=bool(value.get('invert')),
                horizontal=bool(value.get('horizontal')),
                scale=scale if isinstance(scale, str) and len(scale) <= 32 else 'page-width',
                diffHighlight=value.get('diffHighlight') is not False,
                sourceDiffHighlight=value.get('sourceDiffHighlight') is not False,
                selectionHighlight=value.get('selectionHighlight') is not False)


def load_settings():
    try:
        return settings(json.loads(SETTINGS_FILE.read_text('utf-8')))
    except (OSError, ValueError):
        return settings()


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def page_number(value):
    try:
        number = float(value or 0)
        return (int(number) if number.is_integer() else number) if math.isfinite(number) else None
    except (ValueError, TypeError):
        return None


def read_text(file):
    with file.open('r', encoding='utf-8', newline='') as source:
        return source.read()


def mtime(file):
    return file.stat().st_mtime_ns / 1_000_000


class Library:
    def __init__(self, config_file):
        self.config_file = config_file.resolve()
        self.config = json.loads(config_file.read_text('utf-8-sig'))
        base, config = self.config_file.parent, self.config
        self.volumes = []
        volumes = config.get('volumes')
        for index, volume in enumerate(volumes if isinstance(volumes, list) and volumes else [config]):
            pages = volume.get('pages', {})
            options = pages if isinstance(pages, dict) else {}
            identity = str(volume.get('id', config.get('id', index + 1)))
            pattern = options.get('pattern', volume.get('pagePattern', config.get('pagePattern')))
            pdf = volume.get('pdf', config.get('pdf'))
            if isinstance(pdf, dict):
                pdf = pdf.get('file')
            if not pattern or not pdf:
                raise ValueError(f'Volume {identity} requires pages.pattern/pagePattern and pdf')
            pattern = re.sub(r'\(\?<([A-Za-z_]\w*)>', r'(?P<\1>', pattern)
            explicit = options.get('list')
            if not isinstance(explicit, list):
                explicit = pages if isinstance(pages, list) else []
            item = dict(id=identity, title=str(volume.get('title', config.get('title', f'PDF {identity}'))),
                        shortTitle=str(volume.get('shortTitle', volume.get('title', config.get('shortTitle', config.get('title', identity))))),
                        pageLabel=str(volume.get('pageLabel', config.get('pageLabel', '{page}'))),
                        toc=volume.get('toc') if isinstance(volume.get('toc'), list) else [],
                        pattern=re.compile(pattern, re.I), explicitPages={number for p in explicit if (number := page_number(p)) is not None},
                        pageDir=resource(options.get('directory', volume.get('htmlRoot', config.get('htmlRoot', '.'))), base),
                        pdf=resource(pdf, base))
            self.scan(item)
            if item['pages']:
                self.volumes.append(item)
        editor = resource(config.get('editorRoot') or '.', base)
        self.editor_root = editor['path'] if editor['kind'] == 'file' and editor['path'].exists() else None
        self.clients, self.clients_lock = set(), threading.Lock()

    def scan(self, volume):
        directory, files = volume['pageDir'], {}
        if directory['kind'] == 'file' and directory['path'].is_dir():
            for entry in directory['path'].iterdir():
                match = volume['pattern'].search(entry.name)
                if entry.is_dir() or not match:
                    continue
                try:
                    page = float(match.groupdict().get('page') if match.groupdict().get('page') is not None else match.group(1))
                    if not math.isfinite(page):
                        continue
                    page = int(page) if page.is_integer() else page
                except (ValueError, TypeError, IndexError):
                    continue
                if not volume['explicitPages'] or page in volume['explicitPages']:
                    files[page] = entry.name
        elif directory['kind'] == 'url':
            files = dict.fromkeys(volume['explicitPages'])
        volume['pageFiles'], volume['pages'] = files, sorted(files)

    def volume(self, identity):
        for volume in self.volumes:
            if volume['id'] == str(identity):
                return volume
        raise ValueError(f'找不到卷册 {identity}')

    def location(self, volume, page):
        if page not in volume['pages'] or not volume['pageFiles'][page]:
            raise ValueError(f'Page {page} has no corresponding file')
        directory, name = volume['pageDir'], volume['pageFiles'][page]
        return directory['path'] / name if directory['kind'] == 'file' else directory['path'] + '/' + name

    def editor_path(self, volume, page):
        if self.editor_root and volume['pageDir']['kind'] == 'file':
            location = self.location(volume, page)
            if inside(location, self.editor_root):
                return location.relative_to(self.editor_root).as_posix()
        return None

    def editor_target(self, relative=''):
        if not self.editor_root:
            raise ValueError('No local editor root configured')
        full = (self.editor_root / unquote(relative).lstrip('/\\')).resolve()
        if not inside(full, self.editor_root):
            raise ValueError(f'Path outside root: {self.editor_root}')
        relative = full.relative_to(self.editor_root).as_posix()
        return full, '' if relative == '.' else relative

    def publish(self, event, path):
        with self.clients_lock:
            for client in self.clients:
                client.put(dict(event=event, path=path))

    def watch(self, stop):
        # Native fs.watch is replaced by one shared poller, including external HTML edits.
        previous = None
        while not stop.wait(0.3):
            current = {}
            roots = {self.editor_root} if self.editor_root else set()
            roots.update(v['pageDir']['path'] for v in self.volumes if v['pageDir']['kind'] == 'file'
                         and (not self.editor_root or not inside(v['pageDir']['path'], self.editor_root)))
            for root in roots:
                try:
                    entries = root.rglob('*') if root == self.editor_root else root.iterdir()
                    for file in entries:
                        if file.is_file() or file.is_dir():
                            stat = file.stat()
                            relative = file.relative_to(self.editor_root).as_posix() if self.editor_root and inside(file, self.editor_root) else ''
                            current[str(file)] = (stat.st_mtime_ns, stat.st_size, relative)
                except OSError:
                    continue
            if previous is not None:
                for name in current.keys() | previous.keys():
                    if current.get(name) != previous.get(name):
                        relative = (current.get(name) or previous[name])[2]
                        self.publish('rename' if not relative or name not in current or name not in previous else 'change', relative)
            previous = current


def reply(status, value, content_type='application/json; charset=utf-8'):
    if not isinstance(value, (bytes, str)):
        value = json.dumps(value, ensure_ascii=False)
    return Response(value, status_code=status, media_type=content_type, headers={'cache-control': 'no-store'})


def create_app(library, legacy=False):
    public = HERE / ('public_legacy' if legacy else 'public')
    monaco = HERE / 'monaco' if (HERE / 'monaco/min/vs/loader.js').exists() else HERE / 'node_modules/monaco-editor'

    @asynccontextmanager
    async def lifespan(app):
        stop = threading.Event()
        worker = threading.Thread(target=library.watch, args=(stop,), daemon=True)
        worker.start()
        try:
            yield
        finally:
            stop.set()
            await run_in_threadpool(worker.join)

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    def file_response(file, ranges=False, fallback='application/octet-stream'):
        if ranges:
            # FileResponse streams PDFs and handles Range, Content-Range, 416 and HEAD.
            return FileResponse(file, media_type='application/pdf', headers={'cache-control': 'no-store'})
        return reply(200, file.read_bytes(), MIME.get(file.suffix.lower(), fallback))

    def css():
        try:
            return (library.editor_root / 'mewde.css').read_text('utf-8')
        except (OSError, TypeError):
            return 'body { background: #fff; color: #1d2430; font-family: serif; line-height: 1.5; }\n'

    async def events():
        client = queue.Queue()
        with library.clients_lock:
            library.clients.add(client)
        try:
            yield 'data: {"event":"ready","path":""}\n\n'
            heartbeat = asyncio.get_running_loop().time() + 25
            while True:
                try:
                    message = client.get_nowait()
                    yield 'data: ' + json.dumps(message, ensure_ascii=False) + '\n\n'
                except queue.Empty:
                    if asyncio.get_running_loop().time() >= heartbeat:
                        yield ': keep-alive\n\n'
                        heartbeat = asyncio.get_running_loop().time() + 25
                    await asyncio.sleep(0.1)
        finally:
            with library.clients_lock:
                library.clients.discard(client)

    def dispatch(request, data):
        path = request.url.path
        param = lambda name, fallback='': request.query_params.get(name, fallback)
        parts = [p for p in path.split('/') if p]
        method = request.method
        if path == '/api/reader/config':
            volumes = []
            for volume in library.volumes:
                if volume['pageDir']['kind'] == 'file':
                    library.scan(volume)
                volumes.append({**{k: volume[k] for k in ('id', 'title', 'shortTitle', 'pages', 'toc', 'pageLabel')},
                    'pdfUrl': volume['pdf']['path'] if volume['pdf']['kind'] == 'url' else '/api/reader/pdf/' + quote(volume['id'], safe='')})
            return reply(200, dict(title=library.config.get('title') or '阅读器', configPath=str(library.config_file),
                editorRoot=str(library.editor_root) if library.editor_root else None,
                editorAvailable=bool(library.editor_root), volumes=volumes))
        if path == '/api/reader/settings':
            if method == 'GET':
                return reply(200, load_settings())
            if method == 'PUT':
                value = settings({**load_settings(), **data})
                SETTINGS_FILE.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', 'utf-8')
                return reply(200, value)
            return reply(405, dict(error='Only GET or PUT supported'))
        if path == '/api/reader/locate':
            if not library.editor_root:
                return reply(404, dict(error='此配置没有本地编辑目录'))
            _, relative = library.editor_target(param('path'))
            for volume in library.volumes:
                for page in volume['pages']:
                    target = library.editor_path(volume, page)
                    if target and target.lower() == relative.lower():
                        return reply(200, dict(volume=volume['id'], page=page, path=target))
            return reply(404, dict(error='File is not in the reader configuration'))
        if path.startswith('/api/reader/') and len(parts) >= 4:
            kind, volume = parts[2], library.volume(parts[3])
            if kind == 'pdf':
                if volume['pdf']['kind'] != 'file' or not volume['pdf']['path'].is_file():
                    return reply(404, 'PDF not found', 'text/plain')
                return file_response(volume['pdf']['path'], ranges=True)
            if kind == 'resource':
                directory = volume['pageDir']
                if directory['kind'] != 'file':
                    return reply(404, 'Not found', 'text/plain')
                file = (directory['path'] / '/'.join(parts[4:])).resolve()
                if not inside(file, directory['path']):
                    return reply(403, 'Forbidden', 'text/plain')
                return file_response(file)
            if kind in ('page', 'link') and len(parts) >= 5:
                page = page_number(parts[4])
                if page not in volume['pages']:
                    raise ValueError(f'第 {parts[4]} 页不存在')
                target = library.editor_path(volume, page)
                if kind == 'link':
                    return reply(200, dict(volume=volume['id'], page=page, path=target)) if target else reply(404, dict(error='Page outside editor root'))
                if method == 'GET':
                    file = library.location(volume, page)
                    local = volume['pageDir']['kind'] == 'file'
                    if local:
                        text = read_text(file)
                    else:
                        with urlopen(file) as response:
                            text = response.read().decode('utf-8')
                    return reply(200, dict(volume=volume['id'], page=page, path=target, text=text,
                                               mtime=mtime(file) if local else None, editable=local))
                if method == 'PUT':
                    if volume['pageDir']['kind'] != 'file':
                        return reply(403, dict(error='Remote page is read-only'))
                    file = library.location(volume, page)
                    if finite(data.get('mtime')) and abs(mtime(file) - data['mtime']) > 1:
                        return reply(409, dict(error='File changed on disk. Reload before saving.'))
                    file.write_text(str(data['text']) if data.get('text') is not None else '', encoding='utf-8', newline='')
                    return reply(200, dict(ok=True, mtime=mtime(file)))
        if path == '/api/events' and method == 'GET':
            return StreamingResponse(events(), media_type='text/event-stream', headers={'cache-control': 'no-cache', 'connection': 'keep-alive'})
        if path == '/api/tree':
            directory, _ = library.editor_target(param('path'))
            natural = lambda name: tuple((1, int(p)) if p.isdigit() else (0, p.lower()) for p in re.split(r'(\d+)', name))
            entries = sorted((f for f in directory.iterdir() if not f.name.startswith('.')),
                             key=lambda f: (not f.is_dir(), natural(f.name)))
            return reply(200, dict(root=str(library.editor_root), entries=[dict(name=f.name,
                path=f.relative_to(library.editor_root).as_posix(), type='dir' if f.is_dir() else 'file') for f in entries]))
        if path == '/api/file':
            file, relative = library.editor_target(param('path'))
            if not file.is_file():
                return reply(400, dict(error='Not a file'))
            return reply(200, dict(path=relative, text=read_text(file), mtime=mtime(file)))
        if path in ('/api/save', '/api/create') and method == 'POST':
            file, relative = library.editor_target(data.get('path') or '')
            exists = file.exists()
            if path == '/api/create':
                if not relative or re.search(r'[\\/:*?"<>|\x00-\x1f]|[. ]$', file.name) or re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', file.name, re.I):
                    raise ValueError('Invalid file name')
                if not file.parent.is_dir():
                    return reply(400, dict(error='Target directory does not exist'))
                if exists and not data.get('overwrite'):
                    return reply(409, dict(error='A file with this name already exists.', code='FILE_EXISTS', mtime=mtime(file)))
                if exists and not file.is_file():
                    return reply(400, dict(error='Target is not a file'))
                if exists and (not finite(data.get('mtime')) or abs(mtime(file) - data['mtime']) > 1):
                    return reply(409, dict(error='Target file changed before it could be overwritten.', code='TARGET_CHANGED', mtime=mtime(file)))
            else:
                before = mtime(file)
                if finite(data.get('mtime')) and abs(before - data['mtime']) > 1:
                    return reply(409, dict(error='File changed on disk. Reload before saving.', mtime=before))
            try:
                with file.open('x' if path == '/api/create' and not exists else 'w', encoding='utf-8', newline='') as output:
                    output.write(str(data['text']) if data.get('text') is not None else '')
            except FileExistsError:
                return reply(409, dict(error='A file with this name already exists.', code='FILE_EXISTS', mtime=mtime(file)))
            return reply(201 if path == '/api/create' else 200, dict(ok=True, path=relative, mtime=mtime(file)))
        if path.startswith('/raw/'):
            file, _ = library.editor_target(path[5:])
            if file.suffix.lower() != '.html':
                return file_response(file)
            safe = lambda value: value if re.fullmatch(r'[#\w\s(),.%+\-]+', value) else '#fff'
            text = f'<style>{css()}</style><style>body{{background:{safe(param("bg", "#fff"))};color:{safe(param("fg", "#1d2430"))}}}</style>' + read_text(file)
            return reply(200, text, MIME['.html'])
        if path == '/mewde.css':
            return reply(200, css(), MIME['.css'])
        if path.startswith('/api/'):
            return reply(404, dict(error='Unknown API'))
        root, relative = public, path.lstrip('/') or 'reader.html'
        for prefix, directory in (('/vendor/pdfjs/', HERE / 'node_modules/pdfjs-dist'), ('/monaco/', monaco)):
            if path.startswith(prefix):
                root, relative = directory, path[len(prefix):]
                break
        file = (root / relative).resolve()
        if not inside(file, root):
            return reply(403, 'Forbidden', 'text/plain')
        if not file.is_file():
            return reply(404, 'Not found', 'text/plain')
        return file_response(file, fallback='text/plain; charset=utf-8' if root == public else 'application/octet-stream')

    @app.api_route('/{path:path}', methods=['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT'])
    async def route(request: Request):
        try:
            needs_body = (request.url.path == '/api/reader/settings' and request.method == 'PUT'
                          or request.url.path.startswith('/api/reader/page/') and request.method == 'PUT'
                          or request.url.path in ('/api/save', '/api/create') and request.method == 'POST')
            data = json.loads(await request.body() or b'{}') if needs_body else {}
            response = await run_in_threadpool(dispatch, request, data)
        except Exception as error:
            response = reply(400, dict(error=str(error)))
        if request.method == 'HEAD' and isinstance(response, Response) and hasattr(response, 'body'):
            response.body = b''
        return response

    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('-c', '--config', type=Path)
    parser.add_argument('-p', '--port', type=int, default=int(os.environ.get('PORT', 49100)))
    parser.add_argument('--legacy', action='store_true')
    args = parser.parse_args()
    config = find_default_config(args.config)
    try:
        library = Library(config)
    except (OSError, ValueError) as error:
        parser.exit(1, f'加载配置失败（{config}）：{error}\n')
    if not library.volumes:
        parser.exit(1, f'配置 {config} 没有扫描到任何卷。请检查 htmlRoot 与 pagePattern。\n')
    server = uvicorn.Server(uvicorn.Config(create_app(library, args.legacy), host='0.0.0.0', port=args.port))
    if os.environ.get('MEW_READER_LAUNCHER') == '1':
        def launcher_closed():
            sys.stdin.buffer.read()
            server.should_exit = True
        threading.Thread(target=launcher_closed, daemon=True).start()
    print(f'配置：{config}\n编辑根：{library.editor_root or "（无）"}\n阅读器：http://localhost:{args.port}（{len(library.volumes)} 卷）', flush=True)
    server.run()


if __name__ == '__main__':
    main()
