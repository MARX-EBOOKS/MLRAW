(() => {
  if (new URLSearchParams(location.search).get("git") !== "1") return;

  const DEFAULT_CSS = `body { background: #fff; color: #1d2430; font-family: "Times New Roman", serif; line-height: 1.5; }\na { color: #1167b1; }\n`;
  const GITHUB_API_VERSION = "2026-03-10";
  const TOKEN_KEY = "mew.git.token";
  const CONFIG_KEY = "mew.git.config";
  let config;
  try { config = JSON.parse(sessionStorage.getItem(CONFIG_KEY) || "null"); } catch {}
  if (!config?.provider || !config.repository || !config.branch) {
    location.replace("../git-editor.html");
    return;
  }
  if (!['github', 'gitlab'].includes(config.provider)) throw new Error('Unsupported Git provider');
  config.repository = String(config.repository).replace(/^\/+|\/+$/g, '');
  if (!/^[^/?#]+(?:\/[^/?#]+)+$/.test(config.repository)) throw new Error('Repository must use owner/repository or group/project form');
  if (/[\u0000-\u001f]/.test(config.branch)) throw new Error('Invalid target branch');
  config.root = cleanPath(config.root || "");
  config.apiUrl = (config.apiUrl || (config.provider === "github" ? "https://api.github.com" : "https://gitlab.com/api/v4")).replace(/\/+$/, "");
  const apiOrigin = new URL(config.apiUrl);
  if (apiOrigin.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(apiOrigin.hostname)) {
    throw new Error("Git API must use HTTPS (plain HTTP is allowed only on localhost)");
  }
  const token = sessionStorage.getItem(TOKEN_KEY) || "";
  const scope = [config.provider, config.apiUrl, config.repository, config.branch, config.root].join("|");
  const baseFiles = new Map();
  let stagedCount = 0;

  function cleanPath(value = "") {
    const parts = String(value).replaceAll("\\", "/").split("/");
    const clean = [];
    for (const part of parts) {
      if (!part || part === ".") continue;
      if (part === ".." || part.includes("\0")) throw new Error("Path outside repository root");
      clean.push(part);
    }
    return clean.join("/");
  }
  const joinPath = (...parts) => cleanPath(parts.filter(Boolean).join("/"));
  const encodePath = value => cleanPath(value).split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const remotePath = value => joinPath(config.root, value);
  const relativePath = value => config.root ? cleanPath(value).slice(config.root.length).replace(/^\//, "") : cleanPath(value);
  const encodeBase64 = text => {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(binary);
  };
  const decodeBase64 = value => {
    const binary = atob(String(value).replace(/\s/g, ""));
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  };

  async function request(endpoint, options = {}) {
    const headers = { accept: "application/json", ...options.headers };
    if (token) {
      if (config.provider === "github") headers.authorization = `Bearer ${token}`;
      else headers["private-token"] = token;
    }
    if (config.provider === "github") {
      headers.accept = "application/vnd.github+json";
      if (new URL(config.apiUrl).hostname === "api.github.com") headers["x-github-api-version"] = GITHUB_API_VERSION;
    }
    const response = await fetch(config.apiUrl + endpoint, { ...options, headers });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
    if (!response.ok) {
      const error = new Error(data?.message || data?.error_description || data?.error || text || `Git API ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return { data, headers: response.headers };
  }
  async function optionalRequest(endpoint) {
    try { return (await request(endpoint)).data; }
    catch (error) { if (error.status === 404) return null; throw error; }
  }
  const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

  function openDraftDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("mew-git-editor", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("drafts", { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function draftOperation(mode, value) {
    const db = await openDraftDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("drafts", mode === "get" || mode === "all" ? "readonly" : "readwrite");
      const store = transaction.objectStore("drafts");
      let operation;
      if (mode === "get") operation = store.get(`${scope}|${value}`);
      else if (mode === "put") operation = store.put({ ...value, id: `${scope}|${value.path}`, scope });
      else if (mode === "delete") operation = store.delete(`${scope}|${value}`);
      else operation = store.getAll();
      operation.onsuccess = () => resolve(mode === "all" ? operation.result.filter(item => item.scope === scope) : operation.result);
      operation.onerror = () => reject(operation.error);
      transaction.oncomplete = () => db.close();
    });
  }
  const getDraft = path => draftOperation("get", path);
  const putDraft = draft => draftOperation("put", draft);
  const deleteDraft = path => draftOperation("delete", path);
  const allDrafts = () => draftOperation("all");
  async function clearDrafts() { for (const draft of await allDrafts()) await deleteDraft(draft.path); }

  const githubRepo = `/repos/${config.repository.split("/").map(encodeURIComponent).join("/")}`;
  const gitlabProject = `/projects/${encodeURIComponent(config.repository)}`;

  async function githubList(path) {
    const suffix = path ? `/${encodePath(path)}` : "";
    const { data } = await request(`${githubRepo}/contents${suffix}?ref=${encodeURIComponent(config.branch)}`);
    if (!Array.isArray(data)) throw new Error("Not a directory");
    return data.filter(item => item.type === "dir" || item.type === "file").map(item => ({ name: item.name, path: item.path, type: item.type }));
  }
  async function githubRead(path) {
    const { data } = await request(`${githubRepo}/contents/${encodePath(path)}?ref=${encodeURIComponent(config.branch)}`);
    if (data.type !== "file") throw new Error("Not a file");
    let content = data.content;
    if (!content) content = (await request(`${githubRepo}/git/blobs/${encodeURIComponent(data.sha)}`)).data.content;
    return { text: decodeBase64(content), version: data.sha };
  }
  async function gitlabList(path) {
    const entries = [];
    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({ ref: config.branch, per_page: "100", page: String(page) });
      if (path) query.set("path", path);
      const response = await request(`${gitlabProject}/repository/tree?${query}`);
      entries.push(...response.data);
      const next = response.headers.get("x-next-page");
      if (!next) break;
      page = Number(next) - 1;
    }
    return entries.filter(item => item.type === "tree" || item.type === "blob").map(item => ({ name: item.name, path: item.path, type: item.type === "tree" ? "dir" : "file" }));
  }
  async function gitlabRead(path) {
    const { data } = await request(`${gitlabProject}/repository/files/${encodeURIComponent(cleanPath(path))}?ref=${encodeURIComponent(config.branch)}`);
    return { text: decodeBase64(data.content), version: data.last_commit_id };
  }
  const providerList = path => config.provider === "github" ? githubList(path) : gitlabList(path);
  const providerRead = path => config.provider === "github" ? githubRead(path) : gitlabRead(path);

  async function readFile(path) {
    const relative = cleanPath(path);
    const remote = remotePath(relative);
    const current = await providerRead(remote);
    baseFiles.set(relative, current);
    const draft = await getDraft(relative);
    if (draft) return { path: relative, text: draft.text, mtime: draft.baseVersion };
    return { path: relative, text: current.text, mtime: current.version };
  }

  async function stageFile(data) {
    const path = cleanPath(data.path || "");
    if (!path) throw new Error("A file path is required");
    const known = baseFiles.get(path) || await providerRead(remotePath(path));
    if (data.mtime && known.version !== data.mtime) throw new Error("File changed in the target branch. Reload before saving.");
    if (String(data.text ?? "") === known.text) await deleteDraft(path);
    else await putDraft({ path, text: String(data.text ?? ""), baseVersion: known.version });
    await updateSubmitButton();
    return { ok: true, path, mtime: known.version };
  }

  async function api(url, options = {}) {
    const parsed = new URL(url, location.href);
    if (parsed.pathname.endsWith("/api/tree")) {
      const relative = cleanPath(parsed.searchParams.get("path") || "");
      const entries = (await providerList(remotePath(relative))).filter(item => !item.name.startsWith(".")).map(item => ({ ...item, path: relativePath(item.path) }));
      entries.sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name, undefined, { numeric: true }));
      return { root: `${config.provider}:${config.repository}@${config.branch}${config.root ? `/${config.root}` : ""}`, entries };
    }
    if (parsed.pathname.endsWith("/api/file")) return readFile(parsed.searchParams.get("path") || "");
    if (parsed.pathname.endsWith("/api/save") && options.method === "POST") return stageFile(JSON.parse(options.body || "{}"));
    if (parsed.pathname.endsWith("/mewde.css")) {
      try { return (await readFile("mewde.css")).text; } catch (error) { if (error.status === 404) return DEFAULT_CSS; throw error; }
    }
    throw new Error(`Unsupported static Git route: ${parsed.pathname}`);
  }

  function branchName() {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    return `mew-edit-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
  }
  async function verifyDrafts(drafts, readAtVersion) {
    const conflicts = [];
    for (const draft of drafts) {
      const current = await readAtVersion(remotePath(draft.path));
      if (current.version !== draft.baseVersion) conflicts.push(draft.path);
    }
    if (conflicts.length) throw new Error(`目标分支中的文件已经变化，请重新打开后再提交：${conflicts.join(", ")}`);
  }
  async function submitGithub(drafts, title, body) {
    const refPath = config.branch.split("/").map(encodeURIComponent).join("/");
    const baseRef = (await request(`${githubRepo}/git/ref/heads/${refPath}`)).data;
    const baseSha = baseRef.object.sha;
    await verifyDrafts(drafts, async path => {
      const { data } = await request(`${githubRepo}/contents/${encodePath(path)}?ref=${encodeURIComponent(baseSha)}`);
      return { version: data.sha };
    });
    const baseCommit = (await request(`${githubRepo}/git/commits/${encodeURIComponent(baseSha)}`)).data;
    const baseTree = (await request(`${githubRepo}/git/trees/${encodeURIComponent(baseCommit.tree.sha)}?recursive=1`)).data;
    if (baseTree.truncated) throw new Error("GitHub repository tree is too large to preserve file modes safely.");
    const modes = new Map((baseTree.tree || []).map(item => [item.path, item.mode]));
    const source = await githubSourceRepository(baseSha);
    const sourceRepo = `/repos/${source.full_name.split("/").map(encodeURIComponent).join("/")}`;
    const tree = [];
    for (const draft of drafts) {
      const blob = (await request(`${sourceRepo}/git/blobs`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: encodeBase64(draft.text), encoding: "base64" })
      })).data;
      const path = remotePath(draft.path);
      tree.push({ path, mode: modes.get(path) || "100644", type: "blob", sha: blob.sha });
    }
    const newTree = (await request(`${sourceRepo}/git/trees`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree })
    })).data;
    const commit = (await request(`${sourceRepo}/git/commits`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: title, tree: newTree.sha, parents: [baseSha] })
    })).data;
    const branch = branchName();
    await request(`${sourceRepo}/git/refs`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha })
    });
    return (await request(`${githubRepo}/pulls`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, body, head: `${source.owner.login}:${branch}`, base: config.branch, maintainer_can_modify: true })
    })).data.html_url;
  }
  async function githubSourceRepository(baseSha) {
    const [target, user] = await Promise.all([(request(githubRepo)).then(result => result.data), (request("/user")).then(result => result.data)]);
    if (target.permissions?.push || target.permissions?.maintain || target.permissions?.admin || target.owner.login.toLowerCase() === user.login.toLowerCase()) return target;
    const candidatePath = `/repos/${encodeURIComponent(user.login)}/${encodeURIComponent(target.name)}`;
    let fork = await optionalRequest(candidatePath);
    if (fork?.parent?.full_name?.toLowerCase() !== target.full_name.toLowerCase()) {
      fork = null;
      for (let page = 1; !fork && page <= 10; page += 1) {
        const response = await request(`${githubRepo}/forks?per_page=100&page=${page}`);
        fork = response.data.find(repo => repo.owner?.login?.toLowerCase() === user.login.toLowerCase());
        if (!response.headers.get("link")?.includes('rel="next"')) break;
      }
    }
    if (!fork && await optionalRequest(candidatePath)) {
      throw new Error(`你的 ${user.login}/${target.name} 已存在且不是该仓库的 fork，请重命名该仓库后重试。`);
    }
    if (!fork) fork = (await request(`${githubRepo}/forks`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ default_branch_only: false })
    })).data;
    const sourcePath = `/repos/${fork.full_name.split("/").map(encodeURIComponent).join("/")}`;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const ready = await optionalRequest(sourcePath);
      if (ready) {
        const commit = await optionalRequest(`${sourcePath}/git/commits/${encodeURIComponent(baseSha)}`);
        if (commit) return ready;
      }
      await wait(2000);
    }
    throw new Error("GitHub fork 尚未准备完成，请稍后再次提交。");
  }
  async function submitGitlab(drafts, title, body) {
    const branch = branchName();
    const branchPath = encodeURIComponent(config.branch);
    const target = (await request(gitlabProject)).data;
    const baseSha = (await request(`${gitlabProject}/repository/branches/${branchPath}`)).data.commit.id;
    await verifyDrafts(drafts, async path => {
      const { data } = await request(`${gitlabProject}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(baseSha)}`);
      return { version: data.last_commit_id };
    });
    const source = await gitlabSourceProject(target);
    const sourceProject = `/projects/${encodeURIComponent(source.id)}`;
    await request(`${sourceProject}/repository/commits`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch, start_sha: baseSha, start_project: target.id, commit_message: title, actions: drafts.map(draft => ({ action: "update", file_path: remotePath(draft.path), content: draft.text, encoding: "text", last_commit_id: draft.baseVersion })) })
    });
    return (await request(`${sourceProject}/merge_requests`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source_branch: branch, target_branch: config.branch, target_project_id: target.id, title, description: body, remove_source_branch: true, allow_collaboration: true })
    })).data.web_url;
  }
  async function gitlabSourceProject(target) {
    const user = (await request("/user")).data;
    const access = Math.max(target.permissions?.project_access?.access_level || 0, target.permissions?.group_access?.access_level || 0);
    if (access >= 30 || target.namespace?.id === user.namespace_id || target.owner?.id === user.id) return target;
    let fork;
    for (let page = 1; !fork; page += 1) {
      const response = await request(`${gitlabProject}/forks?per_page=100&page=${page}`);
      fork = response.data.find(item => item.owner?.id === user.id || item.namespace?.id === user.namespace_id);
      if (!response.headers.get("x-next-page")) break;
    }
    if (!fork) fork = (await request(`${gitlabProject}/fork`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).data;
    const sourceProject = `/projects/${encodeURIComponent(fork.id)}`;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const ready = await optionalRequest(sourceProject);
      if (ready?.import_status === "failed") throw new Error(ready.import_error || "GitLab fork 导入失败");
      if (ready && ["finished", "none"].includes(ready.import_status)) return ready;
      await wait(2000);
    }
    throw new Error("GitLab fork 尚未准备完成，请稍后再次提交。");
  }
  async function submitChanges() {
    const drafts = await allDrafts();
    if (!drafts.length) return alert("没有已暂存的修改。先编辑文件并点击 Save。");
    if (!token) throw new Error("缺少访问令牌，请返回连接页面重新填写。");
    const title = prompt("PR/MR 标题", `Edit ${drafts.length} file${drafts.length === 1 ? "" : "s"} with MEW editor`);
    if (!title) return;
    const body = prompt("PR/MR 说明（可留空）", "Changes prepared in the MEW Git editor.") ?? "";
    const button = document.getElementById("submitChangeBtn");
    button.disabled = true;
    button.textContent = "正在提交…";
    try {
      const url = config.provider === "github" ? await submitGithub(drafts, title, body) : await submitGitlab(drafts, title, body);
      await clearDrafts();
      await updateSubmitButton();
      window.open(url, "_blank", "noopener");
      alert(`已创建 ${config.provider === "github" ? "PR" : "MR"}：\n${url}`);
    } finally {
      button.disabled = false;
      await updateSubmitButton();
    }
  }

  function webBase() {
    if (config.provider === "github") {
      if (apiOrigin.hostname === "api.github.com") return `https://raw.githubusercontent.com/${config.repository.split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(config.branch)}`;
      const site = config.apiUrl.replace(/\/api\/v3$/, "");
      return `${site}/${config.repository.split("/").map(encodeURIComponent).join("/")}/raw/${encodeURIComponent(config.branch)}`;
    }
    const site = config.apiUrl.replace(/\/api\/v4$/, "");
    return `${site}/${config.repository.split("/").map(encodeURIComponent).join("/")}/-/raw/${encodeURIComponent(config.branch)}`;
  }
  function rawUrl(path = "", directory = false) {
    const joined = remotePath(path);
    return `${webBase()}${joined ? `/${encodePath(joined)}` : ""}${directory && joined ? "/" : ""}`;
  }
  function openRaw(path, html, css, colors) {
    const dir = cleanPath(path).split("/").slice(0, -1).join("/");
    const source = `<base href="${rawUrl(dir, true)}"><style>${css || DEFAULT_CSS}</style><style>body{background:${colors.bg};color:${colors.ink}}</style>${html}`;
    const escaped = source.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const shell = `<!doctype html><meta name="viewport" content="width=device-width"><style>html,body,iframe{box-sizing:border-box;width:100%;height:100%;margin:0;border:0}</style><iframe sandbox="allow-scripts" srcdoc="${escaped}"></iframe>`;
    const url = URL.createObjectURL(new Blob([shell], { type: "text/html" }));
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async function snapshot() {
    const files = new Map();
    if (config.provider === "github") {
      const branch = (await request(`${githubRepo}/branches/${encodeURIComponent(config.branch)}`)).data;
      const treeSha = branch.commit?.commit?.tree?.sha;
      const tree = (await request(`${githubRepo}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`)).data;
      if (tree.truncated) return files;
      for (const item of tree.tree || []) if (item.type === "blob") files.set(item.path, item.sha);
    } else {
      for (let page = 1; ; page += 1) {
        const query = new URLSearchParams({ ref: config.branch, recursive: "true", per_page: "100", page: String(page) });
        const response = await request(`${gitlabProject}/repository/tree?${query}`);
        for (const item of response.data) if (item.type === "blob") files.set(item.path, item.id);
        const next = response.headers.get("x-next-page");
        if (!next) break;
        page = Number(next) - 1;
      }
    }
    return files;
  }
  async function branchVersion() {
    if (config.provider === "github") {
      const refPath = config.branch.split("/").map(encodeURIComponent).join("/");
      return (await request(`${githubRepo}/git/ref/heads/${refPath}`)).data.object.sha;
    }
    return (await request(`${gitlabProject}/repository/branches/${encodeURIComponent(config.branch)}`)).data.commit.id;
  }
  function connectEvents(onChange) {
    let previous;
    let previousVersion;
    let busy = false;
    const poll = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const version = await branchVersion();
        if (version === previousVersion) return;
        const next = await snapshot();
        if (previous) for (const path of new Set([...previous.keys(), ...next.keys()])) {
          if (config.root && path !== config.root && !path.startsWith(`${config.root}/`)) continue;
          if (previous.get(path) !== next.get(path)) onChange({ event: previous.has(path) && next.has(path) ? "change" : "rename", path: relativePath(path) });
        }
        previous = next;
        previousVersion = version;
      } catch (error) { console.warn("Git change polling failed", error); }
      finally { busy = false; }
    };
    poll();
    const timer = setInterval(poll, 30000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
    return timer;
  }
  async function updateSubmitButton() {
    stagedCount = (await allDrafts()).length;
    const button = document.getElementById("submitChangeBtn");
    if (button) button.textContent = `提交 ${config.provider === "github" ? "PR" : "MR"}${stagedCount ? ` (${stagedCount})` : ""}`;
  }

  window.MEWBackend = { api, rawUrl, openRaw, connectEvents, submitChanges, config, updateSubmitButton };
  document.title = `MEW · ${config.repository}`;
  window.addEventListener("DOMContentLoaded", updateSubmitButton);
})();
