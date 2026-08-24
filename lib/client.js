window.__ModuleLoader__.load({
  id: "dsh-trivium",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    const { Button } = require("@deepseek-ai/dsh-client-ui-primitives");

    const I18N = {
      zh: {
        nav: "Trivium 记忆",
        sub: "按节点和边记。默认不自动灌全文。归档后 find 不再返回；删除从 .tdb 去掉且不可恢复。",
        loading: "加载中…",
        empty: "还没有打开过工作区，或当前库为空。",
        path: "当前 .tdb",
        nodes: "节点数",
        tokens: "上次短地图 token",
        recall: "注入策略（三选一，默认关）",
        recallHint: "与 autoRecall、实体名折中互斥。改完点右上角保存。",
        recallOff: "关（默认）",
        recallOffHint: "仅 session-start 短地图（≤400 token）。模型自行 ctx_find / ctx_read。",
        recallAuto: "autoRecall",
        recallAutoHint: "本步含直接用户文本时注入最多 3 条 L0（≤300 token）。不调用 ctx_find 工具。",
        recallAnchor: "实体名折中",
        recallAnchorHint: "用户文本命中已有 entity 的 name/aliases 时，注入该实体 1 跳 about/decided/broke/fixed 邻居（≤300 token）。",
        extract: "compaction/end 抽取",
        extractHint: "规则 + 一次小 prompt；失败只记日志。turn 结束后约 12 秒空闲会再抽一次，下次 session-start 也会重放 pending。每轮写入正文合计 ≤3000 字、最多 24 条。",
        markdown: "Markdown 投影",
        markdownHint: "只读导出，带边（- 鉴权走 header X —about→ AuthGateway）。给编辑器和 git 看。改完回写用 JSON 导入或本页编辑，不解析自由散文。",
        exportMd: "导出 Markdown",
        external: "外部记忆一次性导入",
        externalHint: "发现 WorkBuddy MEMORY.md、Claude Code CLAUDE.md、Codex AGENTS.md。偏严宁漏：闲聊、一次性改文件、密钥、乱码、工具 dump、无规则线索的段落跳过。不持续同步，不导入会话 jsonl。每批同样 ≤3000 字 / 24 条。",
        externalImport: "导入找到的文件",
        externalNone: "当前没有找到这些文件。",
        externalFound: "找到",
        update: "检查更新",
        updateHint: "对比本机安装版本和 npm 上的 latest。有新版时给出安装命令，不会在后台自动升级。",
        updateChecking: "正在检查…",
        updateCurrent: "已是最新",
        updateNewer: "有新版本",
        updateInstalled: "已安装",
        updateLatest: "npm latest",
        updateFailed: "暂时查不到 registry",
        embed: "远程 embedding（OpenAI 兼容，默认关）",
        embedHint: "失败退回关键词 + 图检索。需单独的 embeddings endpoint；官方 DeepSeek chat API 不含 embedding。",
        embedReady: "已就绪",
        embedWait: "未就绪：打开开关并填写 http(s) URL 后保存。",
        embedUrl: "Embedding URL",
        embedModel: "模型",
        embedKey: "API Key",
        embedKeyHint: "已保存则留空不改。也可设环境变量 DSH_TRIVIUM_EMBED_KEY。",
        embedBackfill: "回填已有节点向量",
        list: "记忆条目",
        filter: "类型",
        search: "搜索",
        all: "全部",
        archive: "归档",
        remove: "删除",
        saveNode: "保存条目",
        merge: "合并进来",
        mergePick: "并入本条…",
        exportJson: "导出 JSON",
        importJson: "导入 JSON",
        archiveHint: "归档：软删除，find / 短地图不再出现。删除：从库里去掉，不可恢复。合并：同类型节点并入本条，对方 same_as 后归档。",
        save: "保存设置",
        saved: "已保存",
        savedKey: "已保存",
        refresh: "刷新",
        noMatch: "没有匹配的节点。换个关键词，或清空搜索。",
        showStale: "显示过期决策",
        neighbors: "邻居（业务边）",
        aboutThis: "只看挂在这上面的",
        aboutOn: "正在看挂在",
        clearAbout: "返回全部",
        stale: "过期",
        dirty: "脏",
        until: "until",
        name: "名称",
        text: "正文",
        aliases: "别名",
        aliasesPh: "逗号分隔",
        untilPh: "周五 / 下周 / ISO",
        searchPh: "鉴权 / until / about",
        importOk: "导入 {created} 新建 / {merged} 合并，跳过 {skipped}",
        importFail: "导入失败",
        justNow: "刚刚",
        minutesAgo: "{n} 分钟前",
        hoursAgo: "{n} 小时前",
        daysAgo: "{n} 天前",
        boxNext: "后续",
        boxFork: "分支",
        boxCheck: "检查点",
        forkDefault: "分叉 (1)",
        forkName: "分叉",
        trajectory: "轨迹",
        fork: "分叉",
        openChat: "打开对话",
        chatShort: "对",
        boxTitle: "方框标题",
        renameHint: "双击改名",
        rename: "改名",
        noSummary: "（尚无摘要）",
        backfillNone: "没有发现压缩标记或分叉。没压过的会话本来就只有「后续」。要分段请点「生成检查点」。",
        backfillOk: "已同步 {checks} 个检查点、{forks} 条分叉。",
        cutNeedTurn: "当前对话还没有可切的轮次。先在对话里发一条，再生成检查点。",
        cutOk: "已把当前「后续」收成左边一格（seq {seq}），右边仍是后续。这不压缩 DSH 上下文。",
        cutDup: "这个位置已经切过了（seq {seq}）。再聊几轮后再生成。",
        forkOpenFail: "无法打开分叉会话：会话图没有拿到 session.open",
        chatViewFail: "无法切换到对话页：会话图没有拿到同一 chat store 的 setView",
        trajViewFail: "无法切换到轨迹页：会话图没有拿到同一 chat store 的 setView",
        noFork: "当前壳没有 session.fork",
        renameFail: "会话已分叉，但侧边栏改名失败：{err}",
        deleteConfirm: "删除会从 .tdb 里拿掉这 {n} 条，不可恢复。归档只是藏起来，find / 短地图 / 芯片都不再出现。确定删除？",
        sessionMap: "会话图",
        chips: "记忆芯片",
        chipsHint: "共 {n} 条，已钉 {pins}。默认不勾选：不钉就不会按芯片白名单注入，但仍可能被开场短地图点名带上，模型也能 find 到。",
        cutBtn: "生成检查点",
        cutting: "生成中…",
        cutTitle: "把当前「后续」收成左边一格，右边继续当后续。只切情节图，不触发 DSH 压缩。要压上下文请在对话里输入 /compact。",
        updateBtn: "更新检查点",
        updating: "更新中…",
        updateTitle: "读取当前对话里 DSH 已有的压缩标记和侧边栏分叉，补进图。没压过就补不出历史方框。",
        collapse: "收起",
        expand: "展开勾选",
        searchChips: "搜索芯片",
        inheritPins: "分叉时继承钉选",
        addChip: "新增",
        cancelAdd: "取消新增",
        select: "选择",
        cancelSelect: "取消选择",
        chipSelectHint: "点芯片多选。归档：软删除，find / 短地图 / 芯片不再出现，节点还在库里。删除：从 .tdb 去掉，不可恢复。",
        chipClipped: "已截到预算（≤300 token）",
        chipPinHint: "勾选后从当前这段的下一轮注入。空白处拖动画布，滚轮缩放。",
        chipDraftPh: "粘贴或输入要记住的内容。点一次写入，整段就是一条芯片。",
        writePin: "写入并钉选",
        suggested: "建议",
        noChipMatch: "没有匹配的芯片。",
        noChips: "还没有可钉选的 preference / decision / entity。用「新增」写一条。",
        forkDialog: "分叉为新会话",
        forkDialogHint: "这个名字会出现在左侧会话列表里。",
        newSessionName: "新会话名称",
        cancel: "取消",
        forking: "分叉中…",
        noRename: "当前壳没有 session.rename",
      },
      en: {
        nav: "Trivium memory",
        sub: "Stored as nodes and edges. Full text is not auto-injected. Archive hides from find; delete removes from .tdb and cannot be undone.",
        loading: "Loading…",
        empty: "No workspace is open, or the store is empty.",
        path: "Current .tdb",
        nodes: "Nodes",
        tokens: "Last short-map tokens",
        recall: "Injection (pick one, default off)",
        recallHint: "autoRecall and entity-name path are mutually exclusive. Save in the top-right when done.",
        recallOff: "Off (default)",
        recallOffHint: "Session-start short map only (≤400 tokens). The model calls ctx_find / ctx_read itself.",
        recallAuto: "autoRecall",
        recallAutoHint: "When the step has user text, inject at most 3 L0 hits (≤300 tokens). Does not call ctx_find.",
        recallAnchor: "Entity-name path",
        recallAnchorHint: "When user text names an existing entity, inject 1-hop about/decided/broke/fixed neighbors (≤300 tokens).",
        extract: "Extract on compaction/end",
        extractHint: "Rules + one small prompt; failures are logged. Idle ~12s after turn/end also extracts; pending replays on next session-start. Per batch: body ≤3000 chars, at most 24 items.",
        markdown: "Markdown projection",
        markdownHint: "Read-only export with edges (e.g. - auth in header X —about→ AuthGateway). For editors and git. Write back with JSON import or this page, not free prose.",
        exportMd: "Export Markdown",
        external: "One-shot external import",
        externalHint: "Discovers WorkBuddy MEMORY.md, Claude Code CLAUDE.md, and Codex AGENTS.md. Strict: skip chitchat, one-off file edits, secrets, mojibake, tool dumps, and lines with no rule cue. No watch, no session jsonl. Same cap: ≤3000 chars / 24 items.",
        externalImport: "Import found files",
        externalNone: "None of these files were found.",
        externalFound: "Found",
        update: "Check for updates",
        updateHint: "Compare the installed version with npm latest. If a newer version exists, the install command is shown — it does not auto-upgrade.",
        updateChecking: "Checking…",
        updateCurrent: "Up to date",
        updateNewer: "Update available",
        updateInstalled: "Installed",
        updateLatest: "npm latest",
        updateFailed: "Registry unavailable",
        embed: "Remote embedding (OpenAI-compatible, off by default)",
        embedHint: "Failures fall back to keyword + graph search. Needs a separate embeddings endpoint; the official DeepSeek chat API has none.",
        embedReady: "Ready",
        embedWait: "Not ready: turn on and fill an http(s) URL, then save.",
        embedUrl: "Embedding URL",
        embedModel: "Model",
        embedKey: "API Key",
        embedKeyHint: "Leave blank to keep the saved key. Or set DSH_TRIVIUM_EMBED_KEY.",
        embedBackfill: "Backfill vectors",
        list: "Memory entries",
        filter: "Type",
        search: "Search",
        all: "All",
        archive: "Archive",
        remove: "Delete",
        saveNode: "Save entry",
        merge: "Merge in",
        mergePick: "Merge into this…",
        exportJson: "Export JSON",
        importJson: "Import JSON",
        archiveHint: "Archive: soft delete, gone from find / short map. Delete: removed from the store, not recoverable. Merge: same-type node into this one; the other is same_as then archived.",
        save: "Save settings",
        saved: "Saved",
        savedKey: "Saved",
        refresh: "Refresh",
        noMatch: "No matching nodes. Try another keyword, or clear the search.",
        showStale: "Show expired decisions",
        neighbors: "Neighbors (business edges)",
        aboutThis: "Only nodes hanging on this",
        aboutOn: "Showing nodes on",
        clearAbout: "Back to all",
        stale: "expired",
        dirty: "dirty",
        until: "until",
        name: "Name",
        text: "Body",
        aliases: "Aliases",
        aliasesPh: "comma-separated",
        untilPh: "Friday / next week / ISO",
        searchPh: "auth / until / about",
        importOk: "Imported {created} new / {merged} merged, skipped {skipped}",
        importFail: "Import failed",
        justNow: "just now",
        minutesAgo: "{n} min ago",
        hoursAgo: "{n} h ago",
        daysAgo: "{n} d ago",
        boxNext: "Next",
        boxFork: "Branch",
        boxCheck: "Checkpoint",
        forkDefault: "Fork (1)",
        forkName: "Fork",
        trajectory: "Trajectory",
        fork: "Fork",
        openChat: "Open conversation",
        chatShort: "C",
        boxTitle: "Box title",
        renameHint: "Double-click to rename",
        rename: "Rename",
        noSummary: "(no summary yet)",
        backfillNone: "No compaction markers or forks. A never-compacted session only has Next. Split with Create checkpoint.",
        backfillOk: "Synced {checks} checkpoints, {forks} forks.",
        cutNeedTurn: "This conversation has no turn to cut yet. Send a message, then create a checkpoint.",
        cutOk: "Folded current Next into a left box (seq {seq}). Right side is still Next. This does not compact DSH context.",
        cutDup: "Already cut at seq {seq}. Chat a few more turns, then create another.",
        forkOpenFail: "Cannot open the forked session: session map has no session.open",
        chatViewFail: "Cannot switch to Conversation: session map has no shared chat store setView",
        trajViewFail: "Cannot switch to Trajectory: session map has no shared chat store setView",
        noFork: "This host has no session.fork",
        renameFail: "Session forked, but sidebar rename failed: {err}",
        deleteConfirm: "Delete removes these {n} nodes from .tdb and cannot be undone. Archive only hides them from find / short map / chips. Delete anyway?",
        sessionMap: "Session graph",
        chips: "Memory chips",
        chipsHint: "{n} chips, {pins} pinned. Unchecked by default: pinning is a whitelist, but the short map may still name them and the model can still find them.",
        cutBtn: "Create checkpoint",
        cutting: "Creating…",
        cutTitle: "Fold current Next into a left box; the right side stays Next. Plot only — does not compact DSH. Type /compact in the conversation to compact context.",
        updateBtn: "Update checkpoints",
        updating: "Updating…",
        updateTitle: "Read DSH compression markers and sidebar forks in this conversation and backfill the graph. Never compacted still means only Next.",
        collapse: "Collapse",
        expand: "Expand to pin",
        searchChips: "Search chips",
        inheritPins: "Inherit pins on fork",
        addChip: "Add",
        cancelAdd: "Cancel add",
        select: "Select",
        cancelSelect: "Cancel select",
        chipSelectHint: "Click chips to multi-select. Archive: soft delete, gone from find / short map / chips, node stays in .tdb. Delete: removed from .tdb, not recoverable.",
        chipClipped: "Clipped to budget (≤300 tokens)",
        chipPinHint: "Checked chips inject from the next turn of this segment. Drag empty canvas to pan, scroll to zoom.",
        chipDraftPh: "Paste or type a fact. One click writes one chip; a whole paste is still one node.",
        writePin: "Write and pin",
        suggested: "suggested",
        noChipMatch: "No matching chips.",
        noChips: "No preference / decision / entity chips yet. Use Add to write one.",
        forkDialog: "Fork as new session",
        forkDialogHint: "This name appears in the left session list.",
        newSessionName: "New session name",
        cancel: "Cancel",
        forking: "Forking…",
        noRename: "This host has no session.rename",
      },
    };

    let uiLocale = "zh";
    const localeListeners = new Set();

    function normalizeLocale(value) {
      const s = String(value || "").toLowerCase();
      if (s.startsWith("en")) return "en";
      if (s.startsWith("zh")) return "zh";
      return "";
    }

    function setUiLocale(next) {
      const loc = normalizeLocale(next) || "zh";
      if (loc === uiLocale) return;
      uiLocale = loc;
      localeListeners.forEach((fn) => {
        try {
          fn();
        } catch {
          // ignore
        }
      });
    }

    function t(key, vars) {
      let s = (I18N[uiLocale] && I18N[uiLocale][key]) || I18N.en[key] || I18N.zh[key] || key;
      if (vars) {
        Object.keys(vars).forEach((k) => {
          s = s.split("{" + k + "}").join(String(vars[k]));
        });
      }
      return s;
    }

    function useT() {
      const [, bump] = react.useState(0);
      react.useEffect(() => {
        const fn = () => bump((n) => n + 1);
        localeListeners.add(fn);
        return () => localeListeners.delete(fn);
      }, []);
      return t;
    }

    const L = new Proxy(
      {},
      {
        get(_target, key) {
          return t(key);
        },
      },
    );

    const TYPES = ["", "entity", "preference", "decision", "experience", "workspace"];

    const ui = {
      page: { display: "flex", flexDirection: "column", gap: 14, padding: "4px 0 16px", maxWidth: 760 },
      header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
      title: { margin: 0, fontSize: 20, lineHeight: "32px", fontWeight: 650 },
      actions: { display: "flex", alignItems: "center", gap: 8, flexShrink: 0 },
      sub: { margin: 0, fontSize: 13, opacity: 0.72, lineHeight: 1.45 },
      meta: { display: "flex", flexWrap: "wrap", gap: "4px 16px", fontSize: 12, opacity: 0.7 },
      card: {
        border: "1px solid rgba(127,127,127,0.28)",
        borderRadius: 10,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      },
      cardTitle: { fontSize: 13, fontWeight: 650 },
      hint: { fontSize: 12, opacity: 0.62, lineHeight: 1.4 },
      switch: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontWeight: 650, fontSize: 13 },
      radio: { display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", margin: 0 },
      field: { display: "flex", flexDirection: "column", gap: 4 },
      fieldLabel: { fontSize: 12, opacity: 0.75 },
      input: {
        width: "100%",
        boxSizing: "border-box",
        minHeight: 32,
        padding: "6px 8px",
        border: "1px solid rgba(127,127,127,0.35)",
        borderRadius: 6,
        background: "transparent",
      },
      toolbar: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 },
      error: { color: "#c44", fontSize: 13 },
      saved: { fontSize: 12, opacity: 0.75 },
    };

    async function api(path, opts) {
      const resp = await fetch(path, opts);
      let data = null;
      try {
        data = await resp.json();
      } catch {
        data = null;
      }
      if (!resp.ok || (data && data.ok === false)) {
        throw new Error((data && data.message) || "HTTP " + resp.status);
      }
      return data;
    }

    function labeledInput(label, input) {
      return jsxs("label", {
        style: ui.field,
        children: [jsx("span", { style: ui.fieldLabel, children: label }), input],
      });
    }

    function TriviumCard() {
      useT();
      const [status, setStatus] = react.useState(null);
      const [nodes, setNodes] = react.useState([]);
      const [type, setType] = react.useState("");
      const [q, setQ] = react.useState("");
      const [showStale, setShowStale] = react.useState(false);
      const [aboutId, setAboutId] = react.useState("");
      const [expanded, setExpanded] = react.useState(null);
      const [error, setError] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [saved, setSaved] = react.useState(false);
      const [recallMode, setRecallMode] = react.useState("off");
      const [extractEnabled, setExtractEnabled] = react.useState(true);
      const [embeddingEnabled, setEmbeddingEnabled] = react.useState(false);
      const [embeddingUrl, setEmbeddingUrl] = react.useState("");
      const [embeddingModel, setEmbeddingModel] = react.useState("text-embedding-3-small");
      const [embeddingApiKey, setEmbeddingApiKey] = react.useState("");
      const [embeddingApiKeySet, setEmbeddingApiKeySet] = react.useState(false);
      const [edits, setEdits] = react.useState({});
      const [mergeFrom, setMergeFrom] = react.useState({});
      const fileRef = react.useRef(null);
      const [buddyFiles, setBuddyFiles] = react.useState([]);
      const [buddyNote, setBuddyNote] = react.useState("");
      const [updateInfo, setUpdateInfo] = react.useState(null);
      const [updateBusy, setUpdateBusy] = react.useState(false);

      const load = react.useCallback(async () => {
        setError("");
        try {
          const st = await api("/api/dsh-trivium/status");
          setStatus(st);
          setRecallMode(st.recallMode || (st.autoRecall ? "auto" : st.anchorRecall ? "anchor" : "off"));
          setExtractEnabled(st.extractEnabled !== false);
          setEmbeddingEnabled(!!st.embeddingEnabled);
          setEmbeddingUrl(st.embeddingUrl || "");
          setEmbeddingModel(st.embeddingModel || "text-embedding-3-small");
          setEmbeddingApiKeySet(!!st.embeddingApiKeySet);
          const params = new URLSearchParams();
          if (type) params.set("type", type);
          if (q.trim()) params.set("q", q.trim());
          if (showStale) params.set("stale", "1");
          if (aboutId) params.set("about", String(aboutId));
          const qs = params.toString();
          const list = await api("/api/dsh-trivium/nodes" + (qs ? "?" + qs : ""));
          setNodes(list.nodes || []);
          const wb = await api("/api/dsh-trivium/external");
          setBuddyFiles(wb.files || []);
        } catch (err) {
          setError(String(err.message || err));
        }
      }, [type, q, showStale, aboutId]);

      react.useEffect(() => {
        load();
      }, [load]);

      const editOf = (n) =>
        edits[n.id] || {
          name: n.name || "",
          text: n.text || "",
          aliases: (n.aliases || []).join(", "),
          until: n.until || "",
        };

      const saveFlags = async () => {
        setBusy(true);
        setSaved(false);
        try {
          const body = {
            recallMode,
            extractEnabled,
            embeddingEnabled,
            embeddingUrl,
            embeddingModel,
          };
          if (embeddingApiKey.trim()) body.embeddingApiKey = embeddingApiKey.trim();
          await api("/api/dsh-trivium/settings", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          setEmbeddingApiKey("");
          setSaved(true);
          await load();
        } catch (err) {
          setError(String(err.message || err));
        } finally {
          setBusy(false);
        }
      };

      const act = async (id, op) => {
        try {
          await api("/api/dsh-trivium/nodes/" + id + "/" + op, { method: "POST" });
          await load();
        } catch (err) {
          setError(String(err.message || err));
        }
      };

      const saveNode = async (n) => {
        const e = editOf(n);
        try {
          const patch = { name: e.name, text: e.text };
          if (n.type === "entity") {
            patch.aliases = String(e.aliases || "")
              .split(/[,，]/)
              .map((s) => s.trim())
              .filter(Boolean);
          }
          if (n.type === "decision") patch.until = e.until;
          await api("/api/dsh-trivium/nodes/" + n.id, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(patch),
          });
          setEdits((prev) => {
            const next = { ...prev };
            delete next[n.id];
            return next;
          });
          await load();
        } catch (err) {
          setError(String(err.message || err));
        }
      };

      const mergeIntoKeep = async (keepId) => {
        const dropId = mergeFrom[keepId];
        if (!dropId) return;
        try {
          await api("/api/dsh-trivium/nodes/" + keepId + "/merge", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ dropId: Number(dropId) }),
          });
          setMergeFrom((prev) => {
            const next = { ...prev };
            delete next[keepId];
            return next;
          });
          await load();
        } catch (err) {
          setError(String(err.message || err));
        }
      };

      const exportJson = async () => {
        try {
          const data = await api("/api/dsh-trivium/export");
          const blob = new Blob([JSON.stringify(data.graph, null, 2)], { type: "application/json" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "trivium-memory.json";
          a.click();
          URL.revokeObjectURL(a.href);
        } catch (err) {
          setError(String(err.message || err));
        }
      };

      const exportMd = async () => {
        try {
          const resp = await fetch("/api/dsh-trivium/export.md");
          const text = await resp.text();
          if (!resp.ok) {
            let message = "HTTP " + resp.status;
            try {
              message = JSON.parse(text).message || message;
            } catch {
              // keep
            }
            throw new Error(message);
          }
          const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "MEMORY.md";
          a.click();
          URL.revokeObjectURL(a.href);
        } catch (err) {
          setError(String(err.message || err));
        }
      };

      const importBuddy = async () => {
        setBusy(true);
        setBuddyNote("");
        try {
          const r = await api("/api/dsh-trivium/import-external", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          });
          setSaved(true);
          setBuddyNote(
            t("importOk", {
              created: r.created || 0,
              merged: r.merged || 0,
              skipped: r.skipped || 0,
            }),
          );
          await load();
        } catch (err) {
          setError(String(err.message || err));
        } finally {
          setBusy(false);
        }
      };

      const checkUpdate = async () => {
        setUpdateBusy(true);
        try {
          setUpdateInfo(await api("/api/dsh-trivium/update?force=1"));
        } catch (err) {
          setUpdateInfo({ ok: false, error: String(err.message || err) });
        } finally {
          setUpdateBusy(false);
        }
      };

      const importJson = async (file) => {
        if (!file) return;
        setBusy(true);
        try {
          const text = await file.text();
          const graph = JSON.parse(text);
          const r = await api("/api/dsh-trivium/import", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ graph }),
          });
          setSaved(true);
          setError(
            r.ok
              ? ""
              : String(r.message || t("importFail")),
          );
          await load();
        } catch (err) {
          setError(t("importFail") + "：" + String(err.message || err));
        } finally {
          setBusy(false);
          if (fileRef.current) fileRef.current.value = "";
        }
      };

      const backfill = async () => {
        setBusy(true);
        try {
          const r = await api("/api/dsh-trivium/embed-backfill", { method: "POST" });
          setSaved(true);
          setError(r.ok ? "" : String(r.message || "backfill failed"));
        } catch (err) {
          setError(String(err.message || err));
        } finally {
          setBusy(false);
        }
      };

      if (!status && !error) return jsx("div", { children: L.loading });

      const radio = (value, label, hint) =>
        jsxs("label", {
          style: ui.radio,
          children: [
            jsx("input", {
              type: "radio",
              name: "dsh-trivium-recall",
              checked: recallMode === value,
              onChange: () => setRecallMode(value),
              style: { marginTop: 3 },
            }),
            jsxs("span", {
              children: [
                jsx("span", { style: { fontWeight: 600 }, children: label }),
                jsx("span", { style: { display: "block", ...ui.hint }, children: hint }),
              ],
            }),
          ],
        });

      return jsxs("div", {
        style: ui.page,
        children: [
          jsxs("div", {
            style: ui.header,
            children: [
              jsx("h2", { style: ui.title, children: L.nav }),
              jsxs("div", {
                style: ui.actions,
                children: [
                  saved ? jsx("span", { style: ui.saved, children: L.saved }) : null,
                  jsx(Button, {
                    variant: "primary",
                    size: "sm",
                    disabled: busy,
                    onClick: saveFlags,
                    children: busy ? "…" : L.save,
                  }),
                  jsx(Button, { variant: "outline", size: "sm", onClick: load, children: L.refresh }),
                  jsx(Button, { variant: "outline", size: "sm", onClick: exportJson, children: L.exportJson }),
                  jsx(Button, { variant: "outline", size: "sm", onClick: exportMd, children: L.exportMd }),
                  jsx(Button, {
                    variant: "outline",
                    size: "sm",
                    disabled: busy,
                    onClick: () => fileRef.current && fileRef.current.click(),
                    children: L.importJson,
                  }),
                  jsx("input", {
                    type: "file",
                    accept: "application/json,.json",
                    ref: fileRef,
                    style: { display: "none" },
                    onChange: (e) => importJson(e.target.files && e.target.files[0]),
                  }),
                ],
              }),
            ],
          }),
          jsx("p", { style: ui.sub, children: L.sub }),
          error ? jsx("div", { style: ui.error, children: error }) : null,
          status
            ? jsxs("div", {
                style: ui.meta,
                children: [
                  jsx("span", {
                    style: { wordBreak: "break-all" },
                    children: L.path + "  " + (status.dbPath || "—"),
                  }),
                  jsx("span", { children: L.nodes + "  " + (status.nodeCount ?? 0) }),
                  jsx("span", {
                    children:
                      L.tokens +
                      "  " +
                      (status.lastInjectTokens ?? 0) +
                      " / " +
                      (status.mapTokenBudget || 400),
                  }),
                ],
              })
            : null,
          jsxs("div", {
            style: ui.card,
            children: [
              jsx("div", { style: ui.cardTitle, children: L.update }),
              jsx("div", { style: ui.hint, children: L.updateHint }),
              jsx("div", {
                style: ui.hint,
                children: updateBusy
                  ? L.updateChecking
                  : updateInfo
                    ? [
                        L.updateInstalled + "  " + (updateInfo.installed || status?.version || "—"),
                        L.updateLatest + "  " + (updateInfo.latest || "—"),
                        updateInfo.error
                          ? L.updateFailed
                          : updateInfo.newer
                            ? L.updateNewer
                            : L.updateCurrent,
                      ].join(" · ")
                    : L.updateInstalled + "  " + (status?.version || "—"),
              }),
              updateInfo && updateInfo.newer && updateInfo.command
                ? jsx("code", { style: { fontSize: 12 }, children: updateInfo.command })
                : null,
              jsx("div", {
                style: { display: "flex", flexWrap: "wrap", gap: 8 },
                children: jsx(Button, {
                  variant: "outline",
                  size: "sm",
                  disabled: updateBusy,
                  onClick: checkUpdate,
                  children: updateBusy ? L.updateChecking : L.update,
                }),
              }),
            ],
          }),
          jsxs("div", {
            style: ui.card,
            children: [
              jsx("div", { style: ui.cardTitle, children: L.recall }),
              jsx("div", { style: ui.hint, children: L.recallHint }),
              radio("off", L.recallOff, L.recallOffHint),
              radio("auto", L.recallAuto, L.recallAutoHint),
              radio("anchor", L.recallAnchor, L.recallAnchorHint),
            ],
          }),
          jsxs("div", {
            style: ui.card,
            children: [
              jsxs("label", {
                style: ui.switch,
                children: [
                  jsx("input", {
                    type: "checkbox",
                    checked: extractEnabled,
                    onChange: (e) => setExtractEnabled(e.target.checked),
                  }),
                  jsx("span", { children: L.extract }),
                ],
              }),
              jsx("div", { style: ui.hint, children: L.extractHint }),
            ],
          }),
          jsxs("div", {
            style: ui.card,
            children: [
              jsx("div", { style: ui.cardTitle, children: L.markdown }),
              jsx("div", { style: ui.hint, children: L.markdownHint }),
              jsx("div", { style: ui.cardTitle, children: L.external }),
              jsx("div", { style: ui.hint, children: L.externalHint }),
              jsx("div", {
                style: { ...ui.hint, wordBreak: "break-all" },
                children: (buddyFiles || []).some((f) => f.exists)
                  ? L.externalFound +
                    "  " +
                    buddyFiles
                      .filter((f) => f.exists)
                      .map((f) => (f.family ? f.family + " · " : "") + f.path)
                      .join(" · ")
                  : L.externalNone,
              }),
              buddyNote ? jsx("div", { style: ui.saved, children: buddyNote }) : null,
              jsx("div", {
                style: { display: "flex", flexWrap: "wrap", gap: 8 },
                children: jsx(Button, {
                  variant: "outline",
                  size: "sm",
                  disabled: busy || !(buddyFiles || []).some((f) => f.exists),
                  onClick: importBuddy,
                  children: L.externalImport,
                }),
              }),
            ],
          }),
          jsxs("div", {
            style: ui.card,
            children: [
              jsxs("div", {
                style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" },
                children: [
                  jsxs("label", {
                    style: ui.switch,
                    children: [
                      jsx("input", {
                        type: "checkbox",
                        checked: embeddingEnabled,
                        onChange: (e) => setEmbeddingEnabled(e.target.checked),
                      }),
                      jsx("span", { children: L.embed }),
                    ],
                  }),
                  embeddingEnabled
                    ? jsx(Button, {
                        variant: "outline",
                        size: "sm",
                        disabled: busy,
                        onClick: backfill,
                        children: L.embedBackfill,
                      })
                    : null,
                ],
              }),
              jsx("div", {
                style: ui.hint,
                children:
                  L.embedHint +
                  " " +
                  (status && status.embeddingReady ? L.embedReady : L.embedWait),
              }),
              labeledInput(
                L.embedUrl,
                jsx("input", {
                  value: embeddingUrl,
                  onChange: (e) => setEmbeddingUrl(e.target.value),
                  placeholder: "https://api.openai.com/v1/embeddings",
                  style: ui.input,
                }),
              ),
              jsxs("div", {
                style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
                children: [
                  labeledInput(
                    L.embedModel,
                    jsx("input", {
                      value: embeddingModel,
                      onChange: (e) => setEmbeddingModel(e.target.value),
                      placeholder: "text-embedding-3-small",
                      style: ui.input,
                    }),
                  ),
                  labeledInput(
                    L.embedKey,
                    jsx("input", {
                      type: "password",
                      value: embeddingApiKey,
                      onChange: (e) => setEmbeddingApiKey(e.target.value),
                      placeholder: embeddingApiKeySet ? L.savedKey : "",
                      style: ui.input,
                    }),
                  ),
                ],
              }),
              jsx("div", { style: ui.hint, children: L.embedKeyHint }),
            ],
          }),
          jsxs("div", {
            style: ui.card,
            children: [
              jsx("div", { style: ui.cardTitle, children: L.list }),
              jsxs("div", {
                style: ui.toolbar,
                children: [
                  jsxs("label", {
                    style: { display: "flex", alignItems: "center", gap: 6, fontSize: 13 },
                    children: [
                      jsx("span", { style: ui.fieldLabel, children: L.filter }),
                      jsx("select", {
                        value: type,
                        onChange: (e) => setType(e.target.value),
                        style: { ...ui.input, width: "auto", minWidth: 120 },
                        children: TYPES.map((t) =>
                          jsx("option", { value: t, children: t || L.all }, t || "all"),
                        ),
                      }),
                    ],
                  }),
                  jsx("input", {
                    value: q,
                    onChange: (e) => setQ(e.target.value),
                    placeholder: L.search + "  " + L.searchPh,
                    style: { ...ui.input, flex: 1, minWidth: 160 },
                  }),
                  jsxs("label", {
                    style: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, whiteSpace: "nowrap" },
                    children: [
                      jsx("input", {
                        type: "checkbox",
                        checked: showStale,
                        onChange: (e) => setShowStale(e.target.checked),
                      }),
                      jsx("span", { children: L.showStale }),
                    ],
                  }),
                ],
              }),
              aboutId
                ? jsxs("div", {
                    style: { display: "flex", alignItems: "center", gap: 8, fontSize: 13 },
                    children: [
                      jsx("span", { children: L.aboutOn + " #" + aboutId }),
                      jsx(Button, {
                        variant: "outline",
                        size: "sm",
                        onClick: () => setAboutId(""),
                        children: L.clearAbout,
                      }),
                    ],
                  })
                : null,
              jsx("div", { style: ui.hint, children: L.archiveHint }),
              !nodes.length
                ? jsx("div", {
                    style: { opacity: 0.7, fontSize: 13 },
                    children:
                      status && (status.nodeCount || 0) > 0 && (q.trim() || type || aboutId || showStale)
                        ? L.noMatch
                        : L.empty,
                  })
                : jsx("div", {
                    style: { display: "flex", flexDirection: "column", gap: 8 },
                    children: nodes.map((n) => {
                      const open = expanded === n.id;
                      const incoming = n.incoming || [];
                      const outgoing = n.outgoing || [];
                      const hasNeighbors = incoming.length + outgoing.length > 0;
                      const e = editOf(n);
                      const peers = nodes.filter((x) => x.type === n.type && x.id !== n.id && x.type !== "workspace");
                      return jsxs(
                        "div",
                        {
                          style: {
                            border: "1px solid rgba(127,127,127,0.28)",
                            borderRadius: 8,
                            padding: 10,
                            display: "flex",
                            flexDirection: "column",
                            gap: 8,
                          },
                          children: [
                            jsxs("div", {
                              style: { fontWeight: 600, cursor: "pointer", fontSize: 13 },
                              onClick: () => setExpanded(open ? null : n.id),
                              children: [
                                "#" + n.id + " " + n.type,
                                n.name ? " · " + n.name : "",
                                n.until ? " · " + L.until + " " + n.until : "",
                                n.stale ? " · " + L.stale : "",
                                n.dirty ? " · " + L.dirty : "",
                              ],
                            }),
                            jsx("div", { style: { fontSize: 13, opacity: 0.9, lineHeight: 1.4 }, children: n.text }),
                            n.path && n.path.length
                              ? jsx("div", {
                                  style: { fontSize: 12, opacity: 0.65, wordBreak: "break-all" },
                                  children: n.path.join("  |  "),
                                })
                              : null,
                            open && n.type !== "workspace"
                              ? jsxs("div", {
                                  style: { display: "flex", flexDirection: "column", gap: 8 },
                                  children: [
                                    labeledInput(
                                      L.name,
                                      jsx("input", {
                                        value: e.name,
                                        onChange: (ev) =>
                                          setEdits((prev) => ({
                                            ...prev,
                                            [n.id]: { ...editOf(n), name: ev.target.value },
                                          })),
                                        style: ui.input,
                                      }),
                                    ),
                                    labeledInput(
                                      L.text,
                                      jsx("textarea", {
                                        value: e.text,
                                        onChange: (ev) =>
                                          setEdits((prev) => ({
                                            ...prev,
                                            [n.id]: { ...editOf(n), text: ev.target.value },
                                          })),
                                        rows: 3,
                                        style: { ...ui.input, minHeight: 72, resize: "vertical" },
                                      }),
                                    ),
                                    n.type === "entity"
                                      ? labeledInput(
                                          L.aliases,
                                          jsx("input", {
                                            value: e.aliases,
                                            onChange: (ev) =>
                                              setEdits((prev) => ({
                                                ...prev,
                                                [n.id]: { ...editOf(n), aliases: ev.target.value },
                                              })),
                                            placeholder: L.aliasesPh,
                                            style: ui.input,
                                          }),
                                        )
                                      : null,
                                    n.type === "decision"
                                      ? labeledInput(
                                          L.until,
                                          jsx("input", {
                                            value: e.until,
                                            onChange: (ev) =>
                                              setEdits((prev) => ({
                                                ...prev,
                                                [n.id]: { ...editOf(n), until: ev.target.value },
                                              })),
                                            placeholder: L.untilPh,
                                            style: ui.input,
                                          }),
                                        )
                                      : null,
                                    jsxs("div", {
                                      style: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" },
                                      children: [
                                        jsx(Button, {
                                          variant: "outline",
                                          size: "sm",
                                          onClick: () => saveNode(n),
                                          children: L.saveNode,
                                        }),
                                        peers.length
                                          ? jsxs(react.Fragment, {
                                              children: [
                                                jsx("select", {
                                                  value: mergeFrom[n.id] || "",
                                                  onChange: (ev) =>
                                                    setMergeFrom((prev) => ({ ...prev, [n.id]: ev.target.value })),
                                                  style: { ...ui.input, width: "auto", minWidth: 160, flex: 1 },
                                                  children: [
                                                    jsx("option", { value: "", children: L.mergePick }, "none"),
                                                    ...peers.map((p) =>
                                                      jsx(
                                                        "option",
                                                        {
                                                          value: String(p.id),
                                                          children:
                                                            "#" + p.id + " " + (p.name || p.text || "").slice(0, 40),
                                                        },
                                                        p.id,
                                                      ),
                                                    ),
                                                  ],
                                                }),
                                                jsx(Button, {
                                                  variant: "outline",
                                                  size: "sm",
                                                  disabled: !mergeFrom[n.id],
                                                  onClick: () => mergeIntoKeep(n.id),
                                                  children: L.merge,
                                                }),
                                              ],
                                            })
                                          : null,
                                      ],
                                    }),
                                  ],
                                })
                              : null,
                            open && hasNeighbors
                              ? jsxs("div", {
                                  style: { fontSize: 12, opacity: 0.85, display: "flex", flexDirection: "column", gap: 2 },
                                  children: [
                                    jsx("div", { style: { fontWeight: 600 }, children: L.neighbors }),
                                    ...incoming.map((edge) =>
                                      jsx(
                                        "div",
                                        {
                                          children:
                                            "<-" +
                                            edge.label +
                                            "- #" +
                                            edge.from +
                                            (edge.type ? " " + edge.type : "") +
                                            (edge.l0 ? " " + edge.l0 : ""),
                                        },
                                        "in-" + edge.from + "-" + edge.label,
                                      ),
                                    ),
                                    ...outgoing.map((edge) =>
                                      jsx(
                                        "div",
                                        {
                                          children:
                                            edge.label +
                                            "-> #" +
                                            edge.to +
                                            (edge.type ? " " + edge.type : "") +
                                            (edge.l0 ? " " + edge.l0 : ""),
                                        },
                                        "out-" + edge.to + "-" + edge.label,
                                      ),
                                    ),
                                  ],
                                })
                              : null,
                            n.type === "workspace"
                              ? null
                              : jsxs("div", {
                                  style: { display: "flex", gap: 8, flexWrap: "wrap" },
                                  children: [
                                    n.type === "entity"
                                      ? jsx(Button, {
                                          variant: "outline",
                                          size: "sm",
                                          onClick: () => setAboutId(String(n.id)),
                                          children: L.aboutThis,
                                        })
                                      : null,
                                    jsx(Button, {
                                      variant: "outline",
                                      size: "sm",
                                      onClick: () => act(n.id, "archive"),
                                      children: L.archive,
                                    }),
                                    jsx(Button, {
                                      variant: "outline",
                                      size: "sm",
                                      onClick: () => act(n.id, "delete"),
                                      children: L.remove,
                                    }),
                                  ],
                                }),
                          ],
                        },
                        String(n.id),
                      );
                    }),
                  }),
            ],
          }),
        ],
      });
    }

    function relTime(iso) {
      const at = Date.parse(iso);
      if (!Number.isFinite(at)) return "";
      const sec = Math.max(0, Math.round((Date.now() - at) / 1000));
      if (sec < 60) return t("justNow");
      if (sec < 3600) return t("minutesAgo", { n: Math.floor(sec / 60) });
      if (sec < 86400) return t("hoursAgo", { n: Math.floor(sec / 3600) });
      return t("daysAgo", { n: Math.floor(sec / 86400) });
    }

    function kindLabel(kind, current) {
      if (current || kind === "tail") return t("boxNext");
      if (kind === "fork") return t("boxFork");
      return t("boxCheck");
    }

    const GENERIC_BOX_NAMES = {
      当前: 1,
      已压缩: 1,
      分叉: 1,
      分叉点: 1,
      后续: 1,
      分支: 1,
      Current: 1,
      Compacted: 1,
      Fork: 1,
      Checkpoint: 1,
      Next: 1,
      Branch: 1,
    };
    const MAP_BOX_W = 220;
    const MAP_ARROW_W = 96;
    const MAP_PAD = 40;
    const MAP_BOX_H = 120;
    const MAP_KID_GAP = 16;
    const MAP_KID_H = 96;
    const MAP_FORK_WIRE = 28;
    const MAP_COL_H = MAP_PAD * 2 + MAP_BOX_H + 2 * (MAP_KID_H + MAP_KID_GAP + MAP_FORK_WIRE);

    let workspacesList = null;

    function customBoxTitle(node) {
      const name = String(node?.name || "").trim();
      if (!name || GENERIC_BOX_NAMES[name]) return "";
      const summary = String(node?.summary || "").replace(/\s+/g, " ").trim();
      if (name === summary) return "";
      if (summary.length > 48 && (name === summary.slice(0, 47) + "…" || name === summary.slice(0, 48))) return "";
      return name;
    }

    function isGenericCopy(value) {
      const text = String(value || "").replace(/\s+/g, " ").trim();
      return !text || !!GENERIC_BOX_NAMES[text];
    }

    function proseOf(raw) {
      return String(raw || "")
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/\*\*/g, "")
        .replace(/\s+/g, " ")
        .trim();
    }

    function boxBody(node, livePreview) {
      const custom = customBoxTitle(node);
      let raw = proseOf(node?.summary);
      if (isGenericCopy(raw)) raw = "";
      if (!raw && livePreview) raw = proseOf(livePreview);
      if (!raw && custom) raw = custom;
      return raw;
    }

    function lastUserPreview(chat) {
      const order = chat?.order || [];
      const nodes = chat?.nodes;
      if (!nodes || !order.length) return "";
      for (let i = order.length - 1; i >= 0; i -= 1) {
        const n = typeof nodes.get === "function" ? nodes.get(order[i]) : null;
        if (!n || (n.kind !== "user" && n.kind !== "steering")) continue;
        const data = n.data || {};
        const blocks = data.blocks || data.content || data.message?.content;
        let text = data.text || "";
        if (!text && Array.isArray(blocks)) {
          text = blocks
            .map((b) => (typeof b === "string" ? b : b.text || b.content || ""))
            .join(" ");
        }
        const s = proseOf(text);
        if (s && !s.startsWith("/")) return s.slice(0, 240);
      }
      return "";
    }

    function chatAnchorKey(chat, node) {
      const nodes = chat?.nodes;
      if (!nodes || typeof nodes.values !== "function") return "";
      const wantId = String(node?.compactionId || "");
      const wantSeq = Number(node?.atSeq);
      let best = "";
      let bestDist = Infinity;
      for (const n of nodes.values()) {
        const data = n.data || {};
        const id = String(data.id || data.compactionId || "");
        const seq = Number(n.anchorSeq ?? data.seq);
        if (wantId && id && id === wantId) return n.key;
        if (n.kind === "compaction" || n.kind === "manual-compaction") {
          if (Number.isFinite(seq) && Number.isFinite(wantSeq)) {
            if (seq === wantSeq) return n.key;
            const dist = Math.abs(seq - wantSeq);
            if (dist < bestDist) {
              bestDist = dist;
              best = n.key;
            }
          }
        }
      }
      return best;
    }

    function collectChatCompactions(chat) {
      const nodes = chat?.nodes;
      if (!nodes || typeof nodes.values !== "function") return [];
      const rows = [];
      const seen = new Set();
      for (const n of nodes.values()) {
        const kind = n.kind;
        const data = n.data || {};
        let seq;
        let summary = "";
        let compactionId = "";
        if (kind === "compaction") {
          seq = Number(n.anchorSeq ?? data.seq);
          summary = String(data.summary || "");
          compactionId = String(data.compactionId || data.id || "");
        } else if (kind === "manual-compaction") {
          const landed = data.compaction;
          if (!landed) continue;
          seq = Number(landed.seq ?? n.anchorSeq ?? data.command?.seq);
          summary = String(landed.summary || "");
          compactionId = String(landed.compactionId || data.command?.commandId || "");
        } else continue;
        if (!Number.isFinite(seq) || seen.has(seq)) continue;
        seen.add(seq);
        rows.push({ atSeq: seq, compactionId, summary });
      }
      return rows.sort((a, b) => a.atSeq - b.atSeq);
    }

    function lastChatSeq(chat) {
      const nodes = chat?.nodes;
      if (!nodes || typeof nodes.values !== "function") return null;
      let best = -1;
      for (const n of nodes.values()) {
        if (n.kind === "compaction" || n.kind === "manual-compaction") continue;
        const seq = Number(n.anchorSeq ?? n.data?.seq);
        if (Number.isFinite(seq) && seq > best) best = seq;
      }
      if (best < 0) {
        for (const n of nodes.values()) {
          const seq = Number(n.anchorSeq ?? n.data?.seq);
          if (Number.isFinite(seq) && seq > best) best = seq;
        }
      }
      return best >= 0 ? best : null;
    }

    function parentIdOf(row) {
      return String(row?.parentSessionId || row?.parentId || "");
    }

    function collectSessionForks(sessionId, byId, seedLengthOf) {
      const forks = [];
      const seen = new Set();
      const add = (childId, parentId) => {
        const child = String(childId || "");
        const parent = String(parentId || "");
        if (!child || !parent || seen.has(child + ":" + parent)) return;
        const row = byId[child];
        if (row?.origin === "subagent") return;
        seen.add(child + ":" + parent);
        const seed = typeof seedLengthOf === "function" ? seedLengthOf(child) : null;
        const n = Number(seed);
        forks.push({
          childSessionId: child,
          parentSessionId: parent,
          atSeq: Number.isFinite(n) && n > 0 ? n - 1 : undefined,
        });
      };
      const mine = String(sessionId || "");
      const rows = byId || {};
      add(mine, parentIdOf(rows[mine]));
      for (const id of Object.keys(rows)) {
        const parent = parentIdOf(rows[id]);
        if (parent && (parent === mine || id === mine)) add(id, parent);
      }
      return forks;
    }

    function scrollConversation({ key, bottom }) {
      let n = 0;
      const tick = () => {
        const host = document.querySelector("[data-conversation-scroll]");
        if (bottom && host) {
          host.scrollTop = host.scrollHeight;
          return;
        }
        const root = host || document;
        if (key) {
          for (const row of root.querySelectorAll("[data-chat-anchor-key]")) {
            if (row.dataset.chatAnchorKey === key) {
              row.scrollIntoView({ block: "center", inline: "nearest" });
              return;
            }
          }
        }
        if (n < 24) {
          n += 1;
          setTimeout(tick, 50);
        }
      };
      setTimeout(tick, 40);
    }

    function layoutChain(nodes, edges, sessionId, liveSessions) {
      const mine = (nodes || []).filter((n) => n.sessionId === sessionId);
      const checks = mine
        .filter((n) => n.kind === "checkpoint")
        .sort((a, b) => (a.atSeq || 0) - (b.atSeq || 0) || a.id - b.id);
      const tail = mine.find((n) => n.kind === "tail");
      const chain = tail ? checks.concat(tail) : checks;
      const byId = new Map((nodes || []).map((n) => [n.id, n]));
      const attachId = (cutId) => {
        const cut = byId.get(cutId);
        if (!cut || cut.kind !== "fork") return cutId;
        const seq = cut.atSeq || 0;
        const hit = [...checks].reverse().find((n) => (n.atSeq || 0) <= seq);
        return (hit || tail || cut).id;
      };
      const kids = new Map();
      for (const e of edges || []) {
        if (e.label !== "forks_from") continue;
        const child = byId.get(e.from);
        if (!child || child.sessionId === sessionId) continue;
        if (liveSessions && !liveSessions.has(String(child.sessionId))) continue;
        const to = attachId(e.to);
        const list = kids.get(to) || [];
        list.push(child);
        kids.set(to, list);
      }
      return { chain, kids };
    }

    function increasedForkTitle(title) {
      const text = String(title || "").trim();
      if (!text) return t("forkDefault");
      const ascii = /^(.*?)\((\d+)\)$/u.exec(text);
      if (ascii?.[1] != null && ascii[2] != null) return ascii[1] + "(" + (Number(ascii[2]) + 1) + ")";
      const fullWidth = /^(.*?)（(\d+)）$/u.exec(text);
      if (fullWidth?.[1] != null && fullWidth[2] != null) return fullWidth[1] + "（" + (Number(fullWidth[2]) + 1) + "）";
      return text + " (1)";
    }

    function nextForkTitle(byId, sourceId) {
      const row = byId?.[sourceId] || {};
      return increasedForkTitle(row.title || row.displayTitle || "");
    }

    function boxKicker(node, { current, child, sessionTitle }) {
      if (child) return sessionTitle || t("forkName");
      if (current || node?.kind === "tail") return t("boxNext");
      if (node?.atSeq != null && Number(node.atSeq) > 0) return "seq " + node.atSeq;
      return kindLabel(node?.kind, current);
    }

    function splitKids(list) {
      const above = [];
      const below = [];
      (list || []).forEach((kid, i) => {
        if (i % 2 === 0) above.push(kid);
        else below.push(kid);
      });
      return { above, below };
    }

    function chainWorldWidth(len) {
      const n = Math.max(1, len);
      return MAP_PAD * 2 + n * MAP_BOX_W + Math.max(0, n - 1) * MAP_ARROW_W;
    }

    function minPanX(chainLen, canvasW, scale) {
      return Math.min(0, (canvasW || 640) - chainWorldWidth(chainLen) * scale);
    }

    function centerPan(chainLen, canvas, scale) {
      const cw = canvas?.clientWidth || 640;
      const ch = canvas?.clientHeight || 260;
      const worldW = chainWorldWidth(Math.max(1, chainLen));
      const worldH = MAP_COL_H;
      return {
        x: (cw - worldW * scale) / 2,
        y: (ch - worldH * scale) / 2,
      };
    }

    function panToForkChild(nodes, edges, parentSessionId, childSessionId, canvas, scale, liveSessions) {
      const { chain, kids } = layoutChain(nodes, edges, parentSessionId, liveSessions);
      let col = Math.max(0, chain.length - 1);
      let foundKid = false;
      let split = { above: [], below: [] };
      for (let i = 0; i < chain.length; i += 1) {
        const list = kids.get(chain[i].id) || [];
        if (list.some((k) => k.sessionId === childSessionId)) {
          col = i;
          foundKid = true;
          split = splitKids(list);
          break;
        }
      }
      const cw = canvas?.clientWidth || 640;
      const ch = canvas?.clientHeight || 260;
      const x = MAP_PAD + col * (MAP_BOX_W + MAP_ARROW_W);
      const midY = MAP_PAD + (MAP_COL_H - MAP_PAD * 2 - MAP_BOX_H) / 2;
      const aboveH = foundKid && split.above.length ? MAP_KID_H + MAP_KID_GAP + MAP_FORK_WIRE : 0;
      const belowH = foundKid && split.below.length ? MAP_KID_H + MAP_KID_GAP + MAP_FORK_WIRE : 0;
      const y = midY - aboveH;
      const w = foundKid ? 188 : MAP_BOX_W;
      const h = MAP_BOX_H + aboveH + belowH;
      let nextScale = scale;
      if (w * nextScale > cw - 32) nextScale = Math.max(0.35, (cw - 32) / w);
      if ((y + h) * nextScale > ch - 24) {
        nextScale = Math.max(0.35, Math.min(nextScale, (ch - 24) / (y + h)));
      }
      const left = x * nextScale;
      const right = (x + w) * nextScale;
      const top = y * nextScale;
      const bottom = (y + h) * nextScale;
      let panX = 0;
      let panY = 0;
      if (right > cw - 16) panX = cw - 16 - right;
      if (left + panX < 16) panX = 16 - left;
      if (bottom > ch - 16) panY = ch - 16 - bottom;
      if (top + panY < 16) panY = 16 - top;
      return { pan: { x: panX, y: panY }, scale: nextScale };
    }

    function svgIcon(children) {
      return jsxs("svg", {
        width: 15,
        height: 15,
        viewBox: "0 0 16 16",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.6,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true,
        children,
      });
    }

    function ForkIcon() {
      return svgIcon([
        jsx("circle", { cx: 3.2, cy: 8, r: 1.55, fill: "currentColor", stroke: "none" }, "a"),
        jsx("circle", { cx: 12.6, cy: 3.2, r: 1.55, fill: "currentColor", stroke: "none" }, "b"),
        jsx("circle", { cx: 12.6, cy: 12.8, r: 1.55, fill: "currentColor", stroke: "none" }, "c"),
        jsx("path", { d: "M4.7 8h2.1c1.6 0 2.4-.6 3.3-1.8L11.4 4.4" }, "d"),
        jsx("path", { d: "M6.8 8c1.6 0 2.4.6 3.3 1.8l1.3 1.8" }, "e"),
      ]);
    }

    function TrajectoryIcon() {
      return svgIcon([
        jsx("path", { d: "M1.8 11.6h2.3l1.7-7.2h3.1l1.4 4.4H14" }, "a"),
        jsx("circle", { cx: 14, cy: 8.8, r: 1.25, fill: "currentColor", stroke: "none" }, "b"),
      ]);
    }

    function ArrowH() {
      const w = MAP_ARROW_W;
      const y = 9;
      const head = w - 12;
      return jsxs("svg", {
        width: w,
        height: 18,
        viewBox: "0 0 " + w + " 18",
        "aria-hidden": true,
        children: [
          jsx("line", {
            x1: 1,
            y1: y,
            x2: head,
            y2: y,
            stroke: "currentColor",
            strokeWidth: 2.4,
            strokeLinecap: "round",
          }),
          jsx("polygon", {
            points: head + ",3 " + (w - 1) + "," + y + " " + head + ",15",
            fill: "currentColor",
          }),
        ],
      });
    }

    function ArrowV({ dir }) {
      const down = dir !== "up";
      const h = MAP_FORK_WIRE;
      const x = 9;
      const head = h - 10;
      return jsxs("svg", {
        width: 18,
        height: h,
        viewBox: "0 0 18 " + h,
        "aria-hidden": true,
        style: { flexShrink: 0, transform: down ? undefined : "rotate(180deg)" },
        children: [
          jsx("line", {
            x1: x,
            y1: 1,
            x2: x,
            y2: head,
            stroke: "currentColor",
            strokeWidth: 2.4,
            strokeLinecap: "round",
          }),
          jsx("polygon", {
            points: "3," + head + " " + x + "," + (h - 1) + " 15," + head,
            fill: "currentColor",
          }),
        ],
      });
    }

    function sharedChatStore(ctx) {
      try {
        const views = typeof ctx.slots.entries === "function" ? ctx.slots.entries("conversation.view") : [];
        const chat = (views || []).find((e) => e?.options?.id === "chat");
        if (chat?.store) return chat.store;
        const sessions = typeof ctx.slots.entries === "function" ? ctx.slots.entries("conversation.session") : [];
        return sessions?.[0]?.store;
      } catch {
        return undefined;
      }
    }

    const mapUi = {
      root: {
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        gap: 10,
        padding: "8px 4px 12px",
        position: "relative",
      },
      chipsHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" },
      chipsToolbar: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
      chipsActions: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
      chipsTitle: { fontSize: 13, fontWeight: 650 },
      hint: { fontSize: 12, opacity: 0.62 },
      chips: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" },
      chip: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        cursor: "pointer",
        border: "1px solid rgba(127,127,127,0.28)",
        borderRadius: 999,
        padding: "4px 10px",
        maxWidth: 280,
      },
      chipSuggest: { borderColor: "currentColor", background: "rgba(127,127,127,0.08)" },
      suggest: { fontSize: 10, fontWeight: 650, opacity: 0.78, flexShrink: 0 },
      search: {
        width: 200,
        boxSizing: "border-box",
        fontSize: 13,
        padding: "6px 10px",
        borderRadius: 8,
        border: "1px solid rgba(127,127,127,0.28)",
        background: "transparent",
        color: "inherit",
      },
      inherit: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer", margin: 0 },
      chipPicked: { borderColor: "currentColor", background: "rgba(127,127,127,0.18)" },
      draftBox: {
        width: "100%",
        minHeight: 96,
        boxSizing: "border-box",
        fontSize: 13,
        padding: "8px 10px",
        borderRadius: 8,
        border: "1px solid rgba(127,127,127,0.28)",
        background: "transparent",
        color: "inherit",
        resize: "vertical",
        fontFamily: "inherit",
      },
      actionBtn: {
        fontSize: 13,
        padding: "6px 14px",
        borderRadius: 8,
        border: "1px solid rgba(127,127,127,0.35)",
        background: "rgba(127,127,127,0.10)",
        color: "inherit",
        cursor: "pointer",
        flexShrink: 0,
      },
      dangerBtn: {
        fontSize: 13,
        padding: "6px 14px",
        borderRadius: 8,
        border: "1px solid rgba(180,60,60,0.45)",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        flexShrink: 0,
      },
      titleRow: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 },
      title: {
        fontSize: 14,
        fontWeight: 700,
        lineHeight: 1.3,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        minWidth: 0,
        flex: 1,
      },
      titleInput: {
        flex: 1,
        minWidth: 0,
        boxSizing: "border-box",
        fontSize: 13,
        fontWeight: 700,
        padding: "3px 6px",
        borderRadius: 6,
        border: "1px solid currentColor",
        background: "transparent",
        color: "inherit",
      },
      ghostBtn: {
        fontSize: 10,
        padding: "1px 6px",
        borderRadius: 6,
        border: "1px solid rgba(127,127,127,0.35)",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        flexShrink: 0,
        opacity: 0.85,
      },
      iconRow: {
        position: "absolute",
        right: 8,
        bottom: 8,
        zIndex: 3,
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        pointerEvents: "auto",
      },
      iconBtn: {
        width: 32,
        height: 32,
        boxSizing: "border-box",
        padding: 0,
        borderRadius: 7,
        border: "1px solid rgba(127,127,127,0.35)",
        background: "rgba(127,127,127,0.12)",
        color: "inherit",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        pointerEvents: "auto",
        position: "relative",
        zIndex: 4,
      },
      canvas: {
        flex: 1,
        minHeight: 260,
        overflow: "hidden",
        position: "relative",
        cursor: "grab",
        border: "1px solid rgba(127,127,127,0.22)",
        borderRadius: 10,
        touchAction: "none",
      },
      world: {
        transformOrigin: "0 0",
        display: "inline-flex",
        padding: "0 " + MAP_PAD + "px",
        alignItems: "stretch",
        gap: 0,
      },
      col: {
        display: "grid",
        gridTemplateRows: "minmax(0,1fr) auto minmax(0,1fr)",
        justifyItems: "center",
        minHeight: MAP_COL_H,
        width: MAP_BOX_W,
      },
      kidStack: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: MAP_KID_GAP,
        paddingBottom: MAP_KID_GAP,
        width: "100%",
        minHeight: 0,
      },
      kidStackBelow: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-start",
        gap: MAP_KID_GAP,
        paddingTop: MAP_KID_GAP,
        width: "100%",
        minHeight: 0,
      },
      row: { display: "flex", alignItems: "stretch" },
      arrow: {
        display: "grid",
        gridTemplateRows: "minmax(0,1fr) auto minmax(0,1fr)",
        width: MAP_ARROW_W,
        flexShrink: 0,
      },
      arrowMid: {
        height: MAP_BOX_H,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "currentColor",
      },
      forkArrow: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "currentColor",
        opacity: 0.92,
      },
      box: {
        width: 220,
        minHeight: MAP_BOX_H,
        position: "relative",
        borderRadius: 10,
        padding: "10px 12px 40px",
        border: "1px solid rgba(127,127,127,0.35)",
        cursor: "default",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        background: "transparent",
        textAlign: "left",
        pointerEvents: "auto",
        zIndex: 1,
      },
      boxMain: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        cursor: "pointer",
      },
      boxCurrent: { boxShadow: "0 0 0 2px currentColor", borderColor: "currentColor" },
      boxKid: { width: 188, minHeight: MAP_KID_H, padding: "8px 10px 36px", opacity: 0.92 },
      kicker: { fontSize: 11, opacity: 0.62, fontWeight: 650 },
      summary: {
        fontSize: 13,
        lineHeight: 1.4,
        display: "-webkit-box",
        WebkitLineClamp: 3,
        WebkitBoxOrient: "vertical",
        overflow: "hidden",
      },
      error: { color: "#c44", fontSize: 13 },
      foldBtn: {
        fontSize: 12,
        padding: "3px 10px",
        borderRadius: 8,
        border: "1px solid rgba(127,127,127,0.35)",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        flexShrink: 0,
      },
      overlay: {
        position: "absolute",
        inset: 0,
        zIndex: 20,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.28)",
      },
      dialog: {
        width: 360,
        maxWidth: "92%",
        borderRadius: 12,
        border: "1px solid rgba(127,127,127,0.35)",
        background: "var(--dsw-alias-bg-base, #fff)",
        padding: "14px 16px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        boxShadow: "0 8px 28px rgba(0,0,0,0.18)",
      },
      dialogTitle: { fontSize: 14, fontWeight: 650 },
      dialogRow: { display: "flex", justifyContent: "flex-end", gap: 8 },
    };

    function EpisodeBox({ node, current, child, sessionTitle, onJump, onFork, onInspect, onRename, canSetView, busy, livePreview }) {
      const [editing, setEditing] = react.useState(false);
      const [draft, setDraft] = react.useState("");
      const customTitle = customBoxTitle(node);
      const canRename = typeof onRename === "function" && Number.isFinite(Number(node?.id));
      const startEdit = (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (!canRename) return;
        setDraft(customTitle);
        setEditing(true);
      };
      const commitEdit = () => {
        if (!editing) return;
        setEditing(false);
        const next = String(draft || "").trim();
        if (next === customTitle) return;
        onRename(node, next);
      };
      const stopIcon = (e) => {
        e.stopPropagation();
      };
      const inspectBtn = jsx("button", {
        type: "button",
        title: t("trajectory"),
        "aria-label": t("trajectory"),
        "data-map-inspect": "1",
        style: mapUi.iconBtn,
        onPointerDown: stopIcon,
        onPointerUp: stopIcon,
        onClick: (e) => {
          stopIcon(e);
          if (typeof onInspect === "function") onInspect(node);
        },
        children: jsx(TrajectoryIcon, {}),
      });
      const forkBtn = jsx("button", {
        type: "button",
        title: t("fork"),
        "aria-label": t("fork"),
        "data-map-fork": "1",
        disabled: !!busy,
        style: { ...mapUi.iconBtn, ...(busy ? { opacity: 0.4 } : {}) },
        onPointerDown: stopIcon,
        onPointerUp: stopIcon,
        onClick: (e) => {
          stopIcon(e);
          onFork(node);
        },
        children: jsx(ForkIcon, {}),
      });
      const openChatBtn =
        !canSetView
          ? jsx("button", {
              type: "button",
              title: t("openChat"),
              "aria-label": t("openChat"),
              "data-map-open": "1",
              style: mapUi.iconBtn,
              onPointerDown: stopIcon,
              onPointerUp: stopIcon,
              onClick: (e) => {
                stopIcon(e);
                onJump(node);
              },
              children: t("chatShort"),
            })
          : null;
      const titleNode = editing
        ? jsx("input", {
            value: draft,
            autoFocus: true,
            "aria-label": t("boxTitle"),
            style: mapUi.titleInput,
            onPointerDown: (e) => e.stopPropagation(),
            onClick: (e) => e.stopPropagation(),
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                commitEdit();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              }
            },
            onBlur: commitEdit,
          })
        : jsx("div", {
            style: mapUi.title,
            title: t("renameHint"),
            onClick: (e) => e.stopPropagation(),
            onDoubleClick: startEdit,
            children: customTitle,
          });
      const body = boxBody(node, !child && (current || node.kind === "tail") ? livePreview : "");
      const jump = (e) => {
        if (e) e.stopPropagation();
        if (editing) return;
        onJump(node);
      };
      return jsxs("div", {
        "data-map-box": child ? "child" : current ? "current" : "main",
        "data-map-session": String(node.sessionId || ""),
        "data-map-kind": String(node.kind || ""),
        onPointerDown: (e) => e.stopPropagation(),
        onPointerUp: (e) => e.stopPropagation(),
        style: {
          ...mapUi.box,
          ...(current ? mapUi.boxCurrent : {}),
          ...(child ? mapUi.boxKid : {}),
        },
        children: [
          jsxs("div", {
            role: "button",
            tabIndex: 0,
            "data-map-jump": "1",
            style: mapUi.boxMain,
            onClick: jump,
            onKeyDown: (e) => {
              if (editing) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onJump(node);
              }
            },
            children: [
              jsxs("div", {
                style: mapUi.titleRow,
                children: [
                  jsxs("div", {
                    style: { ...mapUi.kicker, flex: 1, minWidth: 0 },
                    title: canRename ? t("renameHint") : undefined,
                    onDoubleClick: startEdit,
                    children: [
                      boxKicker(node, { current, child, sessionTitle }),
                    ],
                  }),
                  canRename
                    ? jsx("button", {
                        type: "button",
                        style: mapUi.ghostBtn,
                        onPointerDown: stopIcon,
                        onClick: startEdit,
                        children: t("rename"),
                      })
                    : null,
                ],
              }),
              customTitle || editing ? titleNode : null,
              jsx("div", { style: mapUi.summary, children: body || t("noSummary") }),
              jsx("div", { style: mapUi.hint, children: relTime(node.createdAt) }),
            ],
          }),
          jsxs("div", {
            style: mapUi.iconRow,
            onPointerDown: stopIcon,
            onClick: stopIcon,
            children: [inspectBtn, forkBtn, openChatBtn],
          }),
        ],
      });
    }

    let pendingSessionNav = null;

    function SessionMapView({ sessionId, useSessions, useSession, fork, open, renameSession, actions, seedLengthOf }) {
      useT();
      const canSetView = typeof actions?.setView === "function";
      const chat = useSession((s) => s.chat);
      const cwd = useSessions((s) => (sessionId == null ? "" : s.byId[sessionId]?.cwd || ""));
      const sessionById = useSessions((s) => s.byId);
      const [archivedIds, setArchivedIds] = react.useState([]);
      const lineageKey = useSessions((s) => {
        const byId = s.byId || {};
        const kids = [];
        for (const id of Object.keys(byId)) {
          if (byId[id]?.parentSessionId === sessionId) kids.push(id);
        }
        kids.sort();
        return String(byId[sessionId]?.parentSessionId || "") + ":" + kids.join(",") + ":" + archivedIds.join(",");
      });
      const [nodes, setNodes] = react.useState([]);
      const [edges, setEdges] = react.useState([]);
      const [chips, setChips] = react.useState([]);
      const [pinIds, setPinIds] = react.useState([]);
      const [clipped, setClipped] = react.useState(false);
      const [error, setError] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [scale, setScale] = react.useState(1);
      const [pan, setPan] = react.useState({ x: 0, y: 0 });
      const [chipQuery, setChipQuery] = react.useState("");
      const [inheritPins, setInheritPins] = react.useState(false);
      const [chipsOpen, setChipsOpen] = react.useState(false);
      const [chipSelect, setChipSelect] = react.useState(false);
      const [pickedIds, setPickedIds] = react.useState([]);
      const [draftOpen, setDraftOpen] = react.useState(false);
      const [draftText, setDraftText] = react.useState("");
      const [forkDraft, setForkDraft] = react.useState(null);
      const [backfillNote, setBackfillNote] = react.useState("");
      const canvasRef = react.useRef(null);
      const dragRef = react.useRef(null);
      const userMovedRef = react.useRef(false);

      react.useEffect(() => {
        const list = workspacesList;
        if (!list || typeof list.subscribe !== "function" || typeof list.getSnapshot !== "function") {
          return undefined;
        }
        const pull = () => {
          try {
            const ids = list.getSnapshot()?.archivedSessionIds || [];
            setArchivedIds(Array.from(ids, String));
          } catch {
            setArchivedIds([]);
          }
        };
        pull();
        return list.subscribe(pull);
      }, []);

      const liveSessions = react.useMemo(() => {
        const archived = new Set(archivedIds);
        const live = new Set();
        for (const id of Object.keys(sessionById || {})) {
          if (!archived.has(id)) live.add(id);
        }
        if (sessionId) live.add(String(sessionId));
        return live;
      }, [archivedIds, sessionById, sessionId]);

      const qs = react.useMemo(() => {
        const params = new URLSearchParams();
        if (cwd) params.set("cwd", cwd);
        if (sessionId) params.set("sessionId", String(sessionId));
        const s = params.toString();
        return s ? "?" + s : "";
      }, [cwd, sessionId]);

      const load = react.useCallback(async () => {
        if (!sessionId) return { nodes: [], edges: [] };
        try {
          const map = await api("/api/dsh-trivium/map" + qs);
          setNodes(map.nodes || []);
          setEdges(map.edges || []);
          const chipResp = await api("/api/dsh-trivium/chips" + qs);
          setChips(chipResp.chips || []);
          const pinResp = await api("/api/dsh-trivium/pins" + qs);
          setPinIds(pinResp.ids || []);
          setClipped(!!pinResp.clipped);
          setError("");
          return map;
        } catch (err) {
          setError(String(err.message || err));
          return { nodes: [], edges: [] };
        }
      }, [qs, sessionId]);

      const applyMap = (resp) => {
        if (Array.isArray(resp?.nodes)) setNodes(resp.nodes);
        if (Array.isArray(resp?.edges)) setEdges(resp.edges);
      };

      const syncCheckpoints = async () => {
        if (!sessionId || busy) return;
        setBusy(true);
        setError("");
        try {
          const compactations = collectChatCompactions(chat);
          const forks = collectSessionForks(sessionId, sessionById, seedLengthOf);
          const resp = await api("/api/dsh-trivium/map/backfill" + qs, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId, compactations, forks }),
          });
          applyMap(resp);
          const checks = Number(resp.checkpoints) || 0;
          const forkN = Number(resp.forks) || 0;
          if (!checks && !forkN) {
            setBackfillNote(t("backfillNone"));
          } else {
            setBackfillNote(t("backfillOk", { checks, forks: forkN }));
          }
        } catch (err) {
          setError(String(err.message || err));
        } finally {
          setBusy(false);
        }
      };

      const cutCheckpoint = async () => {
        if (!sessionId || busy) return;
        const atSeq = lastChatSeq(chat);
        if (atSeq == null) {
          setError(t("cutNeedTurn"));
          return;
        }
        setBusy(true);
        setError("");
        try {
          const resp = await api("/api/dsh-trivium/map/cut" + qs, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              sessionId,
              atSeq,
              summary: lastUserPreview(chat),
            }),
          });
          applyMap(resp);
          if (resp.created) {
            setBackfillNote(t("cutOk", { seq: atSeq }));
          } else {
            setBackfillNote(t("cutDup", { seq: atSeq }));
          }
        } catch (err) {
          setError(String(err.message || err));
        } finally {
          setBusy(false);
        }
      };

      react.useEffect(() => {
        load();
      }, [load, lineageKey]);

      const { chain, kids } = react.useMemo(
        () => layoutChain(nodes, edges, sessionId, liveSessions),
        [nodes, edges, sessionId, liveSessions],
      );

      react.useEffect(() => {
        userMovedRef.current = false;
        setScale(1);
      }, [sessionId]);

      react.useEffect(() => {
        const nav = pendingSessionNav;
        if (!nav || nav.sessionId !== sessionId) return undefined;
        pendingSessionNav = null;
        if (nav.view && typeof actions?.setView === "function") actions.setView(nav.view);
        if (nav.view === "chat") {
          scrollConversation({ bottom: !!nav.bottom, key: nav.key || "" });
        }
        return undefined;
      }, [sessionId]);

      react.useEffect(() => {
        const el = canvasRef.current;
        if (!el) return undefined;
        const place = () => {
          if (userMovedRef.current) return;
          setPan(centerPan(chain.length, el, 1));
        };
        place();
        const ro = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
        if (ro) ro.observe(el);
        return () => {
          if (ro) ro.disconnect();
        };
      }, [chain.length, lineageKey, nodes, edges, sessionId]);

      react.useEffect(() => {
        const el = canvasRef.current;
        if (!el) return undefined;
        const onWheel = (e) => {
          e.preventDefault();
          userMovedRef.current = true;
          const factor = e.deltaY > 0 ? 0.92 : 1.08;
          setScale((s) => Math.min(2.4, Math.max(0.35, s * factor)));
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
      }, []);

      const onPointerDown = (e) => {
        if (e.button !== 0) return;
        if (e.target !== e.currentTarget && e.target.closest?.("[data-map-box]")) return;
        dragRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      };
      const onPointerMove = (e) => {
        const drag = dragRef.current;
        if (!drag) return;
        userMovedRef.current = true;
        setPan({ x: drag.panX + (e.clientX - drag.x), y: drag.panY + (e.clientY - drag.y) });
      };
      const onPointerUp = () => {
        dragRef.current = null;
      };

      const openSession = (id, nav) => {
        if (typeof open !== "function") {
          setError(t("forkOpenFail"));
          return false;
        }
        try {
          pendingSessionNav = nav;
          open(id);
          return true;
        } catch (err) {
          pendingSessionNav = null;
          setError(String(err.message || err));
          return false;
        }
      };

      const jumpToChat = (node) => {
        if (node.sessionId && node.sessionId !== sessionId) {
          openSession(node.sessionId, { sessionId: node.sessionId, view: "chat", bottom: true });
          return;
        }
        if (typeof actions?.setView !== "function") {
          setError(t("chatViewFail"));
          return;
        }
        const toEnd = node.kind === "tail" || !!node.current || !Number(node.atSeq);
        actions.setView("chat");
        if (typeof actions.select === "function") {
          if (toEnd) actions.select(null);
          else actions.select({ turnSeq: Number(node.atSeq) });
        }
        scrollConversation({
          bottom: toEnd,
          key: toEnd ? "" : chatAnchorKey(chat, node),
        });
      };

      const jumpToTrajectory = (node) => {
        if (node?.sessionId && node.sessionId !== sessionId) {
          openSession(node.sessionId, { sessionId: node.sessionId, view: "trajectory" });
          return;
        }
        if (typeof actions?.setView === "function") {
          actions.setView("trajectory");
        } else {
          setError(t("trajViewFail"));
        }
      };

      const renameBox = async (node, name) => {
        if (!Number.isFinite(Number(node?.id))) return;
        try {
          await api("/api/dsh-trivium/episodes/" + node.id + (cwd ? "?cwd=" + encodeURIComponent(cwd) : ""), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name }),
          });
          await load();
        } catch (err) {
          setError(String(err.message || err));
        }
      };

      const forkBox = async (node, title) => {
        if (busy) return;
        setBusy(true);
        setError("");
        try {
          if (typeof fork !== "function") throw new Error(t("noFork"));
          const sourceId = String(node.sessionId || sessionId);
          const opts = { sessionId: sourceId, increaseTitle: true };
          if (!node.current && node.kind !== "tail" && Number.isFinite(Number(node.atSeq))) {
            opts.atSeq = Number(node.atSeq);
          }
          const childId = await fork(opts);
          const wanted = String(title || "").trim();
          if (childId && wanted && typeof renameSession === "function") {
            try {
              await renameSession(childId, wanted);
            } catch (err) {
              setError(t("renameFail", { err: String(err.message || err) }));
            }
          }
          if (inheritPins && childId) {
            await api("/api/dsh-trivium/pins" + (cwd ? "?cwd=" + encodeURIComponent(cwd) : ""), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sessionId: childId, inherit: true, inheritFrom: sourceId }),
            });
          }
          const snap = await load();
          userMovedRef.current = true;
          const next = panToForkChild(
            snap.nodes || [],
            snap.edges || [],
            sessionId,
            childId,
            canvasRef.current,
            scale,
            liveSessions,
          );
          setPan(next.pan);
          setScale(next.scale);
          if (childId) openSession(childId, { sessionId: childId, view: "chat", bottom: true });
        } catch (err) {
          setError(String(err.message || err));
        } finally {
          setBusy(false);
          setForkDraft(null);
        }
      };

      const askFork = (node) => {
        if (busy) return;
        const sourceId = String(node?.sessionId || sessionId);
        setForkDraft({
          node,
          title: nextForkTitle(sessionById, sourceId),
        });
      };

      const togglePin = async (id, on) => {
        const next = on ? pinIds.concat(id).filter((x, i, a) => a.indexOf(x) === i) : pinIds.filter((x) => x !== id);
        try {
          const pin = await api("/api/dsh-trivium/pins" + (cwd ? "?cwd=" + encodeURIComponent(cwd) : ""), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId, ids: next }),
          });
          setPinIds(pin.ids || next);
          setClipped(!!pin.clipped);
        } catch (err) {
          setError(String(err.message || err));
        }
      };

      const qsPins = cwd ? "?cwd=" + encodeURIComponent(cwd) : "";

      const applyChipPayload = (payload) => {
        if (Array.isArray(payload.chips)) setChips(payload.chips);
        if (Array.isArray(payload.pinIds)) setPinIds(payload.pinIds);
        if (payload.clipped != null) setClipped(!!payload.clipped);
      };

      const togglePicked = (id) => {
        setPickedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev.concat(id)));
      };

      const runChipBatch = async (action) => {
        if (!pickedIds.length || busy) return;
        if (action === "delete") {
          if (!window.confirm(t("deleteConfirm", { n: pickedIds.length }))) return;
        }
        setBusy(true);
        setError("");
        try {
          const resp = await api("/api/dsh-trivium/chips/batch" + qsPins, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId, action, ids: pickedIds }),
          });
          applyChipPayload(resp);
          setPickedIds([]);
          setChipSelect(false);
        } catch (err) {
          setError(String(err.message || err));
        } finally {
          setBusy(false);
        }
      };

      const submitChipDraft = async () => {
        const text = draftText.trim();
        if (!text || busy) return;
        setBusy(true);
        setError("");
        try {
          const resp = await api("/api/dsh-trivium/chips" + qsPins, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId, text, pin: true }),
          });
          applyChipPayload(resp);
          setDraftText("");
          setDraftOpen(false);
        } catch (err) {
          setError(String(err.message || err));
        } finally {
          setBusy(false);
        }
      };

      const pinSet = new Set(pinIds);
      const visibleChips = react.useMemo(() => {
        const needle = chipQuery.trim().toLowerCase();
        if (!needle) return chips;
        return chips.filter((c) =>
          [c.name, c.text, c.type, c.l0].some((s) => String(s || "").toLowerCase().includes(needle)),
        );
      }, [chips, chipQuery]);

      const boxProps = {
        onJump: jumpToChat,
        onFork: askFork,
        onInspect: jumpToTrajectory,
        onRename: renameBox,
        canSetView,
        busy,
        livePreview: lastUserPreview(chat),
      };

      return jsxs("div", {
        "data-map-build": "sessions-inject",
        style: mapUi.root,
        children: [
          jsxs("div", {
            style: mapUi.chipsHead,
            children: [
              jsx("div", { style: mapUi.chipsTitle, children: t("chips") }),
              jsx("div", {
                style: mapUi.hint,
                children:
                  backfillNote ||
                  t("chipsHint", { n: chips.length, pins: pinIds.length }),
              }),
              jsxs("div", {
                style: mapUi.chipsActions,
                children: [
                  jsx("button", {
                    type: "button",
                    style: mapUi.actionBtn,
                    disabled: busy,
                    title: t("cutTitle"),
                    onClick: cutCheckpoint,
                    children: busy ? t("cutting") : t("cutBtn"),
                  }),
                  jsx("button", {
                    type: "button",
                    style: mapUi.actionBtn,
                    disabled: busy,
                    title: t("updateTitle"),
                    onClick: syncCheckpoints,
                    children: busy ? t("updating") : t("updateBtn"),
                  }),
                  jsx("button", {
                    type: "button",
                    style: mapUi.actionBtn,
                    onClick: () => setChipsOpen((v) => !v),
                    children: chipsOpen ? t("collapse") : t("expand"),
                  }),
                ],
              }),
            ],
          }),
          chipsOpen
            ? jsxs("div", {
                style: { display: "flex", flexDirection: "column", gap: 8 },
                children: [
                  jsxs("div", {
                    style: mapUi.chipsToolbar,
                    children: [
                      jsx("input", {
                        type: "search",
                        placeholder: t("searchChips"),
                        value: chipQuery,
                        onChange: (e) => setChipQuery(e.target.value),
                        style: mapUi.search,
                      }),
                      jsxs("label", {
                        style: mapUi.inherit,
                        children: [
                          jsx("input", {
                            type: "checkbox",
                            checked: inheritPins,
                            onChange: (e) => setInheritPins(e.target.checked),
                          }),
                          t("inheritPins"),
                        ],
                      }),
                      jsxs("div", {
                        style: mapUi.chipsActions,
                        children: [
                          jsx("button", {
                            type: "button",
                            style: mapUi.actionBtn,
                            onClick: () => {
                              setDraftOpen((v) => !v);
                              setChipSelect(false);
                              setPickedIds([]);
                            },
                            children: draftOpen ? t("cancelAdd") : t("addChip"),
                          }),
                          jsx("button", {
                            type: "button",
                            style: mapUi.actionBtn,
                            onClick: () => {
                              setChipSelect((v) => !v);
                              setPickedIds([]);
                              setDraftOpen(false);
                            },
                            children: chipSelect ? t("cancelSelect") : t("select"),
                          }),
                          chipSelect
                            ? jsx("button", {
                                type: "button",
                                style: mapUi.actionBtn,
                                disabled: !pickedIds.length || busy,
                                onClick: () => runChipBatch("archive"),
                                children: t("archive") + (pickedIds.length ? " " + pickedIds.length : ""),
                              })
                            : null,
                          chipSelect
                            ? jsx("button", {
                                type: "button",
                                style: mapUi.dangerBtn,
                                disabled: !pickedIds.length || busy,
                                onClick: () => runChipBatch("delete"),
                                children: t("remove") + (pickedIds.length ? " " + pickedIds.length : ""),
                              })
                            : null,
                        ],
                      }),
                    ],
                  }),
                  jsx("div", {
                    style: mapUi.hint,
                    children: chipSelect
                      ? t("chipSelectHint")
                      : clipped
                        ? t("chipClipped")
                        : t("chipPinHint"),
                  }),
                  draftOpen
                    ? jsxs("div", {
                        style: { display: "flex", flexDirection: "column", gap: 6 },
                        children: [
                          jsx("textarea", {
                            value: draftText,
                            onChange: (e) => setDraftText(e.target.value),
                            placeholder: t("chipDraftPh"),
                            style: mapUi.draftBox,
                          }),
                          jsx("button", {
                            type: "button",
                            style: { ...mapUi.actionBtn, alignSelf: "flex-start" },
                            disabled: busy || !draftText.trim(),
                            onClick: submitChipDraft,
                            children: t("writePin"),
                          }),
                        ],
                      })
                    : null,
                  visibleChips.length
                    ? jsx("div", {
                        style: mapUi.chips,
                        children: visibleChips.map((c) => {
                          const picked = pickedIds.includes(c.id);
                          return jsxs(
                            chipSelect ? "button" : "label",
                            {
                              type: chipSelect ? "button" : undefined,
                              style: {
                                ...mapUi.chip,
                                ...(c.suggested ? mapUi.chipSuggest : {}),
                                ...(chipSelect && picked ? mapUi.chipPicked : {}),
                              },
                              onClick: chipSelect
                                ? (e) => {
                                    e.preventDefault();
                                    togglePicked(c.id);
                                  }
                                : undefined,
                              children: [
                                chipSelect
                                  ? jsx("input", {
                                      type: "checkbox",
                                      checked: picked,
                                      readOnly: true,
                                      tabIndex: -1,
                                      style: { pointerEvents: "none" },
                                    })
                                  : jsx("input", {
                                      type: "checkbox",
                                      checked: pinSet.has(c.id),
                                      onChange: (e) => togglePin(c.id, e.target.checked),
                                    }),
                                c.suggested ? jsx("span", { style: mapUi.suggest, children: t("suggested") }) : null,
                                jsx("span", {
                                  style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                                  children: (c.type || "") + " · " + (c.l0 || c.name || "#" + c.id),
                                }),
                              ],
                            },
                            String(c.id),
                          );
                        }),
                      })
                    : jsx("div", {
                        style: mapUi.hint,
                        children: chips.length
                          ? t("noChipMatch")
                          : t("noChips"),
                      }),
                ],
              })
            : null,
          error ? jsx("div", { style: mapUi.error, children: error }) : null,
          jsx("div", {
            ref: canvasRef,
            style: mapUi.canvas,
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerCancel: onPointerUp,
            children: jsx("div", {
              style: {
                ...mapUi.world,
                transform: "translate(" + pan.x + "px, " + pan.y + "px) scale(" + scale + ")",
              },
              children:
                chain.length === 0
                  ? jsxs("div", {
                      style: mapUi.col,
                      children: [
                        jsx("div", { style: mapUi.kidStack }),
                        jsx(EpisodeBox, {
                          node: { kind: "tail", summary: "", atSeq: undefined, current: true },
                          current: true,
                          ...boxProps,
                        }),
                        jsx("div", { style: mapUi.kidStackBelow }),
                      ],
                    })
                  : chain.map((node, i) => {
                      const split = splitKids(kids.get(node.id) || []);
                      return jsxs(
                        "div",
                        {
                          style: mapUi.row,
                          children: [
                            jsxs("div", {
                              style: mapUi.col,
                              children: [
                                jsxs("div", {
                                  style: mapUi.kidStack,
                                  children: [
                                    split.above.map((kid) =>
                                      jsx(
                                        EpisodeBox,
                                        {
                                          node: kid,
                                          child: true,
                                          sessionTitle:
                                            (sessionById?.[kid.sessionId] || {}).displayTitle ||
                                            (sessionById?.[kid.sessionId] || {}).title,
                                          ...boxProps,
                                        },
                                        "k" + kid.id,
                                      ),
                                    ),
                                    split.above.length
                                      ? jsx("div", { style: mapUi.forkArrow, children: jsx(ArrowV, { dir: "up" }) })
                                      : null,
                                  ],
                                }),
                                jsx(EpisodeBox, {
                                  node,
                                  current: !!node.current || node.kind === "tail",
                                  ...boxProps,
                                }),
                                jsxs("div", {
                                  style: mapUi.kidStackBelow,
                                  children: [
                                    split.below.length
                                      ? jsx("div", { style: mapUi.forkArrow, children: jsx(ArrowV, { dir: "down" }) })
                                      : null,
                                    split.below.map((kid) =>
                                      jsx(
                                        EpisodeBox,
                                        {
                                          node: kid,
                                          child: true,
                                          sessionTitle:
                                            (sessionById?.[kid.sessionId] || {}).displayTitle ||
                                            (sessionById?.[kid.sessionId] || {}).title,
                                          ...boxProps,
                                        },
                                        "k" + kid.id,
                                      ),
                                    ),
                                  ],
                                }),
                              ],
                            }),
                            i < chain.length - 1
                              ? jsxs("div", {
                                  style: mapUi.arrow,
                                  children: [
                                    jsx("div", {}),
                                    jsx("div", { style: mapUi.arrowMid, children: jsx(ArrowH, {}) }),
                                    jsx("div", {}),
                                  ],
                                })
                              : null,
                          ],
                        },
                        String(node.id),
                      );
                    }),
            }),
          }),
          forkDraft
            ? jsx("div", {
                style: mapUi.overlay,
                onPointerDown: (e) => e.stopPropagation(),
                children: jsxs("form", {
                  style: mapUi.dialog,
                  onSubmit: (e) => {
                    e.preventDefault();
                    if (forkDraft?.node) forkBox(forkDraft.node, forkDraft.title);
                  },
                  children: [
                    jsx("div", { style: mapUi.dialogTitle, children: t("forkDialog") }),
                    jsx("div", {
                      style: mapUi.hint,
                      children: t("forkDialogHint"),
                    }),
                    jsx("input", {
                      autoFocus: true,
                      value: forkDraft.title,
                      "aria-label": t("newSessionName"),
                      onChange: (e) => setForkDraft({ ...forkDraft, title: e.target.value }),
                      style: { ...mapUi.titleInput, flex: "none", width: "100%" },
                    }),
                    jsxs("div", {
                      style: mapUi.dialogRow,
                      children: [
                        jsx("button", {
                          type: "button",
                          style: mapUi.foldBtn,
                          onClick: () => setForkDraft(null),
                          children: t("cancel"),
                        }),
                        jsx("button", {
                          type: "submit",
                          style: mapUi.foldBtn,
                          disabled: busy,
                          children: busy ? t("forking") : t("fork"),
                        }),
                      ],
                    }),
                  ],
                }),
              })
            : null,
        ],
      });
    }

    function apply(ctx) {
      workspacesList = ctx.workspaces?.list || null;
      const sessions = ctx.sessions;
      try {
        const snap = ctx.locale && typeof ctx.locale.getLocale === "function" ? ctx.locale.getLocale() : null;
        if (snap && snap.active) setUiLocale(snap.active);
      } catch {
        // host may not expose locale
      }
      try {
        ctx.on("locale/change", (snap) => {
          if (snap && snap.active) setUiLocale(snap.active);
        });
      } catch {
        // ignore
      }
      ctx.slots.inject(
        "settings.section",
        () =>
          ctx.slots.register(
            {
              name: "settings.section",
              id: "dsh-trivium",
              order: 62,
              label: () => L.nav,
              inject: () => ({}),
            },
            TriviumCard,
          ),
        "dsh-trivium: settings section",
      );
      ctx.slots.inject(
        "conversation.view",
        () => {
          const chatStore = sharedChatStore(ctx);
          return ctx.slots.register(
            {
              name: "conversation.view",
              id: "session-map",
              order: 20,
              label: () => t("sessionMap"),
              ...(chatStore ? { store: chatStore } : {}),
              inject: () => ({
                fork: (opts) => sessions.fork(opts),
                open: (id) => sessions.open(id),
                seedLengthOf: (id) => {
                  try {
                    const seed = sessions.binding?.(id)?.session?.header?.seedLength;
                    const n = Number(seed);
                    return Number.isFinite(n) && n > 0 ? n : null;
                  } catch {
                    return null;
                  }
                },
                renameSession: async (id, title) => {
                  const face = sessions.binding?.(id)?.session;
                  if (!face || typeof face.rename !== "function") {
                    throw new Error(t("noRename"));
                  }
                  const result = await face.rename(title);
                  if (result && result.ok === false) {
                    const err = result.error || {};
                    throw new Error(err.message || err.code || "rename failed");
                  }
                  return result;
                },
              }),
            },
            SessionMapView,
          );
        },
        "dsh-trivium: session map",
      );
    }

    exports.apply = apply;
    exports.inject = ["slots", "sessions", "workspaces"];
    return module.exports;
  },
});
