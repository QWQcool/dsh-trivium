window.__ModuleLoader__.load({
  id: "dsh-trivium",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    const { Button } = require("@deepseek-ai/dsh-client-ui-primitives");

    const L = {
      nav: "Trivium 记忆",
      sub: "把这个工作区里说过的偏好、决策记下来，下次打开还能用。默认不会每句话都塞进对话。",
      loading: "加载中…",
      empty: "这个工作区还没有记忆。先聊几句，或让我记住一件事。",
      path: "记忆文件",
      nodes: "条数",
      tokens: "开场摘要",
      recall: "什么时候自动想起来",
      recallHint: "选一项即可，默认关闭。改完点右上角「保存设置」。",
      recallOff: "不自动想",
      recallOffHint: "只在开头给一张很短的目录。需要时模型会自己去查。",
      recallAuto: "每步都找一找",
      recallAutoHint: "你每说一句话，最多塞进 3 条相关记忆。更全，也更费额度。",
      recallAnchor: "提到名字再想",
      recallAnchorHint: "只有你说到已经记过的名称（比如 AuthGateway）时，才带上和它相关的几条。",
      extract: "对话结束后自动摘记",
      extractHint: "闲下来大约十几秒会把值得记住的话写成条目。记错了可以在下面改或收起来。",
      embed: "用向量帮助查找",
      embedHint: "打开后，换一种说法也能更容易找到旧记忆。找不到合适的接口时，会退回按关键词查找。",
      embedReady: "已经接通。",
      embedWait: "还没接通。打开开关，填好地址后保存。",
      embedUrl: "向量接口地址",
      embedModel: "向量模型",
      embedKey: "密钥",
      embedKeyHint: "已经存过的密钥不用再填。也可以用环境变量 DEEPSEEK_API_KEY。",
      embedBackfill: "给已有记忆补向量",
      embedDetect: "用 DSH 的 DeepSeek 配置",
      list: "已记下的内容",
      filter: "类型",
      search: "搜索",
      all: "全部",
      archive: "收起来",
      remove: "删除",
      saveNode: "保存这条",
      merge: "合并进来",
      mergePick: "选一条合并进来…",
      exportJson: "导出备份",
      importJson: "导入备份",
      archiveHint: "收起来：查找时不再出现，以后还能翻出来。删除：彻底去掉。合并：两条合成一条，旧的会收起来。",
      save: "保存设置",
      saved: "已保存",
      refresh: "刷新",
      noMatch: "没有符合条件的条目。试试换个词，或清空搜索。",
      showStale: "显示过期的",
      neighbors: "相关条目",
      aboutThis: "只看和它有关的",
      aboutOn: "正在看",
      clearAbout: "返回全部",
      stale: "已过期",
      until: "有效期",
      name: "名称",
      text: "内容",
      aliases: "别名",
    };

    const TYPES = ["", "entity", "preference", "decision", "experience", "workspace"];
    const TYPE_LABEL = {
      "": "全部",
      entity: "名称 / 对象",
      preference: "偏好",
      decision: "决策",
      experience: "经验",
      workspace: "工作区",
    };

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
              : String(r.message || "导入失败"),
          );
          await load();
        } catch (err) {
          setError("导入失败：" + String(err.message || err));
        } finally {
          setBusy(false);
          if (fileRef.current) fileRef.current.value = "";
        }
      };

      const detectEmbed = async () => {
        setBusy(true);
        setSaved(false);
        try {
          const r = await api("/api/dsh-trivium/embed-detect", { method: "POST" });
          if (r.embeddingUrl) setEmbeddingUrl(r.embeddingUrl);
          if (r.embeddingModel) setEmbeddingModel(r.embeddingModel);
          setEmbeddingEnabled(!!r.ready || !!r.embeddingEnabled);
          setEmbeddingApiKey("");
          setEmbeddingApiKeySet(!!r.embeddingApiKeySet || !!r.foundKey);
          setSaved(true);
          await load();
          if (!r.ready && r.message) setError(r.message);
          else setError("");
        } catch (err) {
          setError(String(err.message || err));
        } finally {
          setBusy(false);
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
                  jsxs("div", {
                    style: { display: "flex", gap: 8, flexWrap: "wrap" },
                    children: [
                      jsx(Button, {
                        variant: "outline",
                        size: "sm",
                        disabled: busy,
                        onClick: detectEmbed,
                        children: L.embedDetect,
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
                      placeholder: embeddingApiKeySet ? "已保存" : "",
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
                          jsx("option", { value: t, children: TYPE_LABEL[t] || t || L.all }, t || "all"),
                        ),
                      }),
                    ],
                  }),
                  jsx("input", {
                    value: q,
                    onChange: (e) => setQ(e.target.value),
                    placeholder: L.search + "  鉴权 / until / about",
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
                                            placeholder: "逗号分隔",
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
                                            placeholder: "周五 / 下周 / ISO",
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

    function apply(ctx) {
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
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
