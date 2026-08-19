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
      sub: "按节点和边记。归档后 find 不再返回。默认不自动灌全文。",
      loading: "加载中…",
      empty: "还没有打开过工作区，或当前库为空。",
      path: "当前 .tdb",
      nodes: "节点数",
      tokens: "上次短地图 token",
      autoRecall: "自动召回 autoRecall（默认关）",
      extract: "compaction/end 抽取",
      filter: "类型",
      all: "全部",
      archive: "归档",
      remove: "删除",
      save: "保存开关",
      saved: "已保存",
      refresh: "刷新",
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
          const q = type ? "?type=" + encodeURIComponent(type) : "";
          const list = await api("/api/dsh-trivium/nodes" + q);
          setNodes(list.nodes || []);
        } catch (err) {
          setError(String(err.message || err));
        }
      }, [type]);

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
            "规则 + 一次小 prompt；失败只记日志并下次 session-start 重放",
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
          !nodes.length
            ? jsx("div", { style: { opacity: 0.7 }, children: L.empty })
            : jsx("div", {
                style: { display: "flex", flexDirection: "column", gap: 8 },
                children: nodes.map((n) =>
                  jsxs(
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
                        jsx("div", {
                          style: { fontWeight: 600 },
                          children:
                            "#" +
                            n.id +
                            " " +
                            n.type +
                            (n.name ? " · " + n.name : "") +
                            " · edges " +
                            n.edges,
                        }),
                        jsx("div", { style: { fontSize: 13, opacity: 0.9 }, children: n.text }),
                        jsx("div", {
                          style: { fontSize: 12, opacity: 0.65 },
                          children:
                            (n.sourceSession ? "session " + n.sourceSession + " · " : "") +
                            (n.updatedAt || n.createdAt || ""),
                        }),
                        n.type === "workspace"
                          ? null
                          : jsxs("div", {
                              style: { display: "flex", gap: 8 },
                              children: [
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
                  ),
                ),
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
