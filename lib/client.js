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
      sub: "按节点和边记。默认不自动灌全文。归档后 find 不再返回；删除会从 .tdb 去掉且不可恢复。",
      loading: "加载中…",
      empty: "还没有打开过工作区，或当前库为空。",
      path: "当前 .tdb",
      nodes: "节点数",
      tokens: "上次短地图 token",
      autoRecall: "自动召回 autoRecall（默认关）",
      extract: "compaction/end 抽取",
      filter: "类型",
      search: "搜索",
      all: "全部",
      archive: "归档",
      remove: "删除",
      archiveHint: "归档：软删除，find / 短地图不再出现。",
      deleteHint: "删除：从库里去掉，不可恢复。",
      save: "保存开关",
      saved: "已保存",
      refresh: "刷新",
      noMatch: "没有匹配的节点。换个关键词，或清空搜索。",
      showStale: "显示过期决策",
      neighbors: "邻居（业务边）",
      aboutThis: "只看挂在这上面的",
      aboutOn: "正在看挂在",
      clearAbout: "返回全部",
      stale: "过期",
      until: "until",
    };

    const TYPES = ["", "entity", "preference", "decision", "experience", "workspace"];

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

    function fieldRow(label, hint, input) {
      return jsxs("div", {
        style: { display: "flex", flexDirection: "column", gap: 4 },
        children: [
          jsx("span", { children: label }),
          input,
          hint ? jsx("span", { style: { fontSize: 12, opacity: 0.65 }, children: hint }) : null,
        ],
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
      const [autoRecall, setAutoRecall] = react.useState(false);
      const [extractEnabled, setExtractEnabled] = react.useState(true);

      const load = react.useCallback(async () => {
        setError("");
        try {
          const st = await api("/api/dsh-trivium/status");
          setStatus(st);
          setAutoRecall(!!st.autoRecall);
          setExtractEnabled(st.extractEnabled !== false);
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

      const saveFlags = async () => {
        setBusy(true);
        setSaved(false);
        try {
          await api("/api/dsh-trivium/settings", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ autoRecall, extractEnabled }),
          });
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

      if (!status && !error) return jsx("div", { children: L.loading });

      return jsxs("div", {
        style: { display: "flex", flexDirection: "column", gap: 16, padding: 16, maxWidth: 720 },
        children: [
          jsx("h2", { children: L.nav }),
          jsx("p", { style: { opacity: 0.8, margin: 0 }, children: L.sub }),
          error ? jsx("div", { style: { color: "#c44" }, children: error }) : null,
          status
            ? jsxs("div", {
                style: { display: "flex", flexDirection: "column", gap: 6, fontSize: 13 },
                children: [
                  jsx("div", { children: L.path + "：" + (status.dbPath || "—") }),
                  jsx("div", { children: L.nodes + "：" + (status.nodeCount ?? 0) }),
                  jsx("div", {
                    children:
                      L.tokens +
                      "：" +
                      (status.lastInjectTokens ?? 0) +
                      " / " +
                      (status.mapTokenBudget || 400),
                  }),
                ],
              })
            : null,
          fieldRow(
            L.autoRecall,
            "打开后仅在本步含直接用户文本时注入最多 3 条 L0（≤300 token）",
            jsx("input", {
              type: "checkbox",
              checked: autoRecall,
              onChange: (e) => setAutoRecall(e.target.checked),
            }),
          ),
          fieldRow(
            L.extract,
            "规则 + 一次小 prompt；失败只记日志。turn 结束后约 12 秒空闲会再抽一次，下次 session-start 也会重放 pending",
            jsx("input", {
              type: "checkbox",
              checked: extractEnabled,
              onChange: (e) => setExtractEnabled(e.target.checked),
            }),
          ),
          jsxs("div", {
            style: { display: "flex", gap: 8, alignItems: "center" },
            children: [
              jsx(Button, {
                variant: "primary",
                size: "sm",
                disabled: busy,
                onClick: saveFlags,
                children: busy ? "…" : L.save,
              }),
              jsx(Button, { variant: "outline", size: "sm", onClick: load, children: L.refresh }),
              saved ? jsx("span", { children: L.saved }) : null,
            ],
          }),
          jsxs("label", {
            style: { display: "flex", gap: 8, alignItems: "center" },
            children: [
              jsx("span", { children: L.filter }),
              jsx("select", {
                value: type,
                onChange: (e) => setType(e.target.value),
                children: TYPES.map((t) =>
                  jsx("option", { value: t, children: t || L.all }, t || "all"),
                ),
              }),
            ],
          }),
          jsxs("label", {
            style: { display: "flex", gap: 8, alignItems: "center" },
            children: [
              jsx("span", { children: L.search }),
              jsx("input", {
                value: q,
                onChange: (e) => setQ(e.target.value),
                placeholder: "鉴权 / until / about",
                style: { flex: 1, minWidth: 160 },
              }),
            ],
          }),
          jsxs("label", {
            style: { display: "flex", gap: 8, alignItems: "center" },
            children: [
              jsx("input", {
                type: "checkbox",
                checked: showStale,
                onChange: (e) => setShowStale(e.target.checked),
              }),
              jsx("span", { children: L.showStale }),
            ],
          }),
          aboutId
            ? jsxs("div", {
                style: { display: "flex", gap: 8, alignItems: "center", fontSize: 13 },
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
          jsxs("div", {
            style: { fontSize: 12, opacity: 0.65 },
            children: [L.archiveHint, " ", L.deleteHint],
          }),
          !nodes.length
            ? jsx("div", {
                style: { opacity: 0.7 },
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
                  return jsxs(
                    "div",
                    {
                      style: {
                        border: "1px solid rgba(127,127,127,0.35)",
                        borderRadius: 8,
                        padding: 10,
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                      },
                      children: [
                        jsxs("div", {
                          style: { fontWeight: 600, cursor: "pointer" },
                          onClick: () => setExpanded(open ? null : n.id),
                          children: [
                            "#" + n.id + " " + n.type,
                            n.name ? " · " + n.name : "",
                            n.until ? " · " + L.until + " " + n.until : "",
                            n.stale ? " · " + L.stale : "",
                            " · edges " + n.edges,
                          ],
                        }),
                        jsx("div", { style: { fontSize: 13, opacity: 0.9 }, children: n.text }),
                        n.path && n.path.length
                          ? jsx("div", {
                              style: { fontSize: 12, opacity: 0.7 },
                              children: "path: " + n.path.join(" | "),
                            })
                          : null,
                        jsx("div", {
                          style: { fontSize: 12, opacity: 0.65 },
                          children:
                            (n.sourceSession ? "session " + n.sourceSession + " · " : "") +
                            (n.updatedAt || n.createdAt || ""),
                        }),
                        open && hasNeighbors
                          ? jsxs("div", {
                              style: { fontSize: 12, opacity: 0.85, paddingLeft: 4 },
                              children: [
                                jsx("div", { style: { fontWeight: 600 }, children: L.neighbors }),
                                ...incoming.map((e) =>
                                  jsx(
                                    "div",
                                    {
                                      children:
                                        "<-" +
                                        e.label +
                                        "- #" +
                                        e.from +
                                        (e.type ? " " + e.type : "") +
                                        (e.l0 ? " " + e.l0 : ""),
                                    },
                                    "in-" + e.from + "-" + e.label,
                                  ),
                                ),
                                ...outgoing.map((e) =>
                                  jsx(
                                    "div",
                                    {
                                      children:
                                        e.label +
                                        "-> #" +
                                        e.to +
                                        (e.type ? " " + e.type : "") +
                                        (e.l0 ? " " + e.l0 : ""),
                                    },
                                    "out-" + e.to + "-" + e.label,
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
