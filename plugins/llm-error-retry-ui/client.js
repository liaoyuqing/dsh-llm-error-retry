// dsh-user-llm-error-retry-ui — 浏览器半（手写 CJS-table bundle，注册协议与打包产物一致）。
// 在 GUI「设置」面板注册一个 "LLM 错误重试" 分区：规则编辑 + 实时状态 + 最近活动。
// 数据面走同源 fetch 到宿主插件 llm-error-retry 的 /llm-error-retry/api/config 路由。
// 全文件防御式 try/catch：任何一步失败只损失本卡片，不影响应用启动；
// 组件内 hooks 恒在前、构造渲染树在 try/catch 内，保证 hooks 顺序稳定。
window.__ModuleLoader__.load({
  id: "dsh-user-llm-error-retry-ui",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    exports.inject = ["slots"];
    exports.apply = function () {};
    try {
      var React = require("react");
      var API = "/llm-error-retry/api/config";
      var OUTCOMES = {
        mounted: "挂载", sleeping: "休眠等待中", retrying: "已重新发起请求",
        cancelled: "休眠被取消", exhausted: "预算耗尽，错误上报", saved: "配置已保存",
      };
      var S = {
        root: { fontSize: "13px", lineHeight: 1.6, padding: "16px 20px 24px", maxWidth: "760px", color: "var(--dsw-alias-label-primary, inherit)" },
        title: { fontSize: "15px", fontWeight: 600, margin: "0 0 2px" },
        sub: { fontSize: "12px", opacity: 0.65, margin: "0 0 12px" },
        meta: { fontSize: "12px", opacity: 0.75, margin: "0 0 10px" },
        table: { width: "100%", borderCollapse: "collapse" },
        th: { textAlign: "left", fontWeight: 500, fontSize: "12px", opacity: 0.7, padding: "4px 6px", borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))" },
        td: { padding: "4px 6px", borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.15))" },
        input: { background: "var(--dsw-alias-bg-layer-3, rgba(127,127,127,.08))", color: "inherit", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))", borderRadius: "6px", padding: "3px 8px", font: "inherit", boxSizing: "border-box" },
        btn: { background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,.12))", color: "inherit", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))", borderRadius: "6px", padding: "4px 12px", font: "inherit", cursor: "pointer" },
        primary: { background: "var(--dsw-alias-brand-primary, #2f6feb)", color: "#fff", border: "none", borderRadius: "6px", padding: "4px 14px", font: "inherit", cursor: "pointer", fontWeight: 600 },
        del: { background: "transparent", border: "none", color: "var(--dsw-alias-label-error, #e0605f)", cursor: "pointer", font: "inherit", padding: "2px 8px" },
        toolbar: { display: "flex", gap: "10px", margin: "12px 0 4px", flexWrap: "wrap", alignItems: "center" },
        ok: { fontSize: "12px", color: "#57ab5a", minHeight: "20px" },
        err: { fontSize: "12px", color: "var(--dsw-alias-label-error, #e0605f)", minHeight: "20px" },
        warn: { fontSize: "12px", color: "#d9a441" },
        events: { listStyle: "none", padding: 0, margin: "4px 0 0", fontSize: "12px", opacity: 0.85, maxHeight: "160px", overflowY: "auto" },
        eventLi: { padding: "2px 0", borderBottom: "1px dashed rgba(127,127,127,.15)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
        hint: { fontSize: "12px", opacity: 0.6, marginTop: "10px" },
      };

      function readConfigResponse(res) {
        return res.text().then(function (text) {
          var data = null;
          try { data = JSON.parse(text); } catch (e) { data = null; }
          if (data === null) {
            throw new Error("HTTP " + res.status + " " + (text.length === 0 ? "空响应体" : text.slice(0, 80)));
          }
          if (!res.ok || !Array.isArray(data.rules)) {
            throw new Error("HTTP " + res.status + " " + ((data && data.error) || "unexpected response"));
          }
          return data;
        });
      }
      function getJson() {
        return fetch(API, { credentials: "same-origin", cache: "no-store" }).then(readConfigResponse);
      }
      function postRules(rules) {
        return fetch(API, {
          method: "POST", credentials: "same-origin", cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rules: rules }),
        }).then(function (res) {
          return res.text().then(function (text) {
            var data = null;
            try { data = JSON.parse(text); } catch (e) { data = null; }
            if (data === null) throw new Error("HTTP " + res.status + " " + (text.length === 0 ? "空响应体" : text.slice(0, 80)));
            return data;
          });
        });
      }
      function cloneRules(list) {
        return (list || []).map(function (r) { return { code: r.code, delayMs: r.delayMs, maxRetries: r.maxRetries }; });
      }

      function apply(ctx) {
        try {
          return ctx.slots.inject("settings.section", function () {
            try {
              return ctx.slots.register(
                { name: "settings.section", id: "llm-error-retry", order: 60, label: "LLM 错误重试" },
                Section,
              );
            } catch (e) { console.error("[llm-error-retry-ui] register failed", e); return undefined; }
          });
        } catch (e) { console.error("[llm-error-retry-ui] apply failed", e); return undefined; }
      }

      function Section() {
        var snapPair = React.useState({ loading: true, rules: [], activity: [], waiting: 0, source: "", error: "", notice: "" });
        var snap = snapPair[0]; var setSnap = snapPair[1];
        var draftPair = React.useState(null);
        var draft = draftPair[0]; var setDraft = draftPair[1];

        function pull(keepNotice) {
          getJson().then(function (cfg) {
            setSnap(function (prev) {
              return {
                loading: false, rules: cfg.rules, activity: cfg.lastEvents || [],
                waiting: cfg.waiting || 0, source: cfg.source || "", error: "",
                notice: keepNotice ? prev.notice : "",
              };
            });
          }).catch(function (e) {
            setSnap(function (prev) {
              return { loading: false, rules: prev.rules, activity: prev.activity, waiting: 0, source: prev.source, error: String((e && e.message) || e), notice: prev.notice };
            });
          });
        }

        React.useEffect(function () {
          pull(false);
          var timer = setInterval(function () { pull(true); }, 3000);
          return function () { clearInterval(timer); };
        }, []);

        var rows = draft !== null ? draft : snap.rules;
        var dirty = draft !== null;

        function base() { return cloneRules(draft !== null ? draft : snap.rules); }
        function updateRow(i, field, value) {
          setDraft(function () {
            var b = base();
            if (b[i] === undefined) return b;
            if (field === "code") b[i].code = value;
            else if (field === "delay") b[i].delayMs = Math.max(0, Math.round((parseFloat(value) || 0) * 1000));
            else b[i].maxRetries = Math.max(0, Math.round(Number(value) || 0));
            return b;
          });
        }
        function addRow() { setDraft(function () { var b = base(); b.push({ code: "", delayMs: 60000, maxRetries: 10 }); return b; }); }
        function removeRow(i) { setDraft(function () { var b = base(); b.splice(i, 1); return b; }); }
        function setNotice(notice) { setSnap(function (prev) { return { loading: false, rules: prev.rules, activity: prev.activity, waiting: prev.waiting, source: prev.source, error: "", notice: notice }; }); }
        function save() {
          var payload = rows
            .filter(function (r) { return String(r.code).trim() !== ""; })
            .map(function (r) { return { code: String(r.code).trim(), delayMs: r.delayMs, maxRetries: r.maxRetries }; });
          postRules(payload).then(function (res) {
            if (res && res.ok) { setDraft(null); setNotice("已保存，立即生效并持久化"); pull(true); }
            else { setNotice("保存失败：" + ((res && res.error) || "未知错误")); }
          }).catch(function (e) { setNotice("保存失败：" + String((e && e.message) || e)); });
        }
        function discard() { setDraft(null); }

        try {
          var e = React.createElement;
          var children = [];
          children.push(e("div", { style: S.title, key: "t" }, "LLM 错误休眠重试"));
          children.push(e("div", { style: S.sub, key: "s" }, "命中错误码/条件 → 休眠 → 重新请求。每条规则（数字 429、机器码 QUOTA、字段=值 code=insufficient_quota 三形态）独立配置休眠与次数；按顺序取第一条命中；优先于内置快速重试。"));
          children.push(e("div", { style: S.meta, key: "m" }, snap.loading ? "加载中…" : (
            "当前生效：" + (snap.rules.length ? snap.rules.map(function (r) { return r.code + " → " + Math.round(r.delayMs / 1000) + "s ×" + r.maxRetries; }).join("；") : "无规则（全部交给内置策略）")
            + " ｜ 来源：" + (snap.source === "file" ? "本界面保存" : "cordis.patch.yml 默认值")
          )));
          if (snap.waiting > 0) children.push(e("div", { style: S.warn, key: "w" }, "当前有 " + snap.waiting + " 个请求正在休眠等待重试…"));

          var head = e("thead", null, e("tr", null,
            e("th", { style: S.th }, "错误码 / 条件"),
            e("th", { style: S.th }, "休眠（秒）"),
            e("th", { style: S.th }, "最大重试次数"),
            e("th", { style: S.th }, "")));
          var bodyRows = [];
          if (rows.length === 0 && !snap.loading) {
            bodyRows.push(e("tr", { key: "empty" }, e("td", { colSpan: 4, style: { padding: "8px", opacity: 0.6, textAlign: "center" } }, "无规则：全部错误交给内置策略处理")));
          }
          rows.forEach(function (row, i) {
            bodyRows.push(e("tr", { key: i },
              e("td", { style: S.td }, e("input", { style: Object.assign({}, S.input, { width: "200px" }), value: row.code, placeholder: "429 / RATE_LIMIT / code=xxx", onChange: function (ev) { updateRow(i, "code", ev.target.value); } })),
              e("td", { style: S.td }, e("input", { type: "number", min: "0.1", step: "1", style: Object.assign({}, S.input, { width: "90px" }), value: row.delayMs / 1000, onChange: function (ev) { updateRow(i, "delay", ev.target.value); } })),
              e("td", { style: S.td }, e("input", { type: "number", min: "0", max: "100", step: "1", style: Object.assign({}, S.input, { width: "80px" }), value: row.maxRetries, onChange: function (ev) { updateRow(i, "max", ev.target.value); } })),
              e("td", { style: S.td }, e("button", { style: S.del, title: "删除该规则", onClick: function () { removeRow(i); } }, "×"))));
          });
          children.push(e("table", { style: S.table, key: "tbl" }, head, e("tbody", null, bodyRows)));
          children.push(e("div", { style: S.toolbar, key: "bar" },
            e("button", { style: S.btn, onClick: addRow }, "＋ 添加错误码"),
            dirty ? e("button", { style: S.primary, key: "save", onClick: save }, "保存（立即生效）") : null,
            dirty ? e("button", { style: S.btn, key: "discard", onClick: discard }, "放弃修改") : null));
          if (snap.notice !== "") children.push(e("div", { style: snap.notice.indexOf("失败") >= 0 ? S.err : S.ok, key: "n" }, snap.notice));
          if (snap.error !== "") children.push(e("div", { style: S.err, key: "e" }, "宿主接口异常：" + snap.error + "（若插件刚重启稍候自动恢复）"));
          children.push(e("div", { style: S.hint, key: "h" }, "规则码三种形态：① HTTP 状态码（429、500…：匹配 status、code 与 message 中独立数字）；② 机器码（RATE_LIMIT、QUOTA、SERVER…）；③ 字段=值（如 code=insufficient_quota、type=rate_limit_exceeded：匹配 provider 返回 JSON 字段，含被压平进 message 的响应体）。多条规则按顺序取第一条命中。保存持久化到 llm-error-retry.rules.json；删除该文件回落到 cordis.patch.yml 默认规则。"));
          children.push(e("div", { style: Object.assign({}, S.title, { marginTop: "14px", fontSize: "13px" }), key: "eh" }, "最近活动"));
          if ((snap.activity || []).length === 0) {
            children.push(e("div", { style: { opacity: 0.6, fontSize: "12px" }, key: "ae" }, "暂无记录"));
          } else {
            children.push(e("ul", { style: S.events, key: "al" }, snap.activity.slice(0, 12).map(function (a) {
              var when = "";
              try { when = new Date(a.at).toLocaleTimeString(); } catch (err) { when = String(a.at); }
              var detail = a.type === "mounted" || a.type === "saved"
                ? "规则: " + (a.rules || []).join(", ")
                : (a.failure || "") + " · 规则「" + (a.rule || "") + "」 第 " + (a.retry !== undefined ? a.retry : (a.attempts || "?")) + "/" + (a.maxRetries !== undefined ? a.maxRetries : "?") + " 次"
                  + (a.delayMs !== undefined ? " · 休眠 " + Math.round(a.delayMs / 1000) + "s" : "");
              return e("li", { key: a.seq, style: S.eventLi }, when + " · " + (OUTCOMES[a.type] || a.type) + " · " + detail);
            })));
          }
          return e("div", { style: S.root }, children);
        } catch (error) {
          return e("div", { style: S.err }, "LLM 错误重试界面渲染失败：" + String((error && error.message) || error));
        }
      }

      exports.apply = apply;
    } catch (error) {
      console.error("[dsh-user-llm-error-retry-ui] factory failed", error);
    }
    return module.exports;
  },
});
