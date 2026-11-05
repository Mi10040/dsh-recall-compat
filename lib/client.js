// Browser half of dsh-recall.
//
// 1. A custom ToolView for the `recall` tool: while the tool runs the row shows
//    a sweeping light over “回忆中…”; when it settles the row collapses to a
//    quiet status line. The agent surfaces the actual results in its reply, so
//    the UI stays minimal and costs no model context.
// 2. A Settings section (“Recall 记忆”) that shows the memory report —
//    sessions, indexed documents, semantic coverage, index size, embedding
//    backlog, last recall — and edits the runtime settings. The Host serves
//    both over same-origin routes guarded by the browser connection.
//
// This file is served verbatim by the host's client-modules bundle route and
// executed through the lazy CJS module table. No bundler/transpiler runs on
// it — plain ES2017-ish JS with React from the browser module table.
window.__ModuleLoader__.load({
	id: "dsh-recall",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");

		// ── styles ──────────────────────────────────────────────────────────
		var CSS_ID = "dsh-recall/styles";
		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-recall";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = [
				// Tool row
				".rcl-row{display:flex;align-items:center;gap:8px;min-height:24px;padding:2px 0;color:var(--dsw-alias-label-secondary,#646a73);font-size:14px;line-height:24px;position:relative;overflow:hidden}",
				".rcl-icon{flex:none;width:16px;height:16px;color:var(--dsw-alias-label-secondary,#8f959e)}",
				".rcl-text{flex:auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
				// 回忆中：文字上一道光波扫过（与官方工具行 sweep 同风格，纯 CSS）
				".rcl-recalling .rcl-text::after{content:\"\";position:absolute;top:0;bottom:0;width:140px;background:linear-gradient(90deg,transparent 0%,color-mix(in srgb,var(--dsw-alias-bg-base) 45%,transparent) 55%,transparent 100%);pointer-events:none;animation:1.8s ease-out infinite rcl-sweep}",
				"@keyframes rcl-sweep{0%{left:-140px}90%,to{left:100%}}",
				".rcl-done{color:var(--dsw-alias-label-secondary,#8f959e)}",
				".rcl-error{color:var(--dsw-alias-state-error-primary,#d54941)}",
				// Settings page
				".rcl-page{display:flex;flex-direction:column;gap:16px;max-width:760px;padding:24px 32px 40px;color:var(--dsw-alias-label-primary)}",
				".rcl-head{display:flex;align-items:flex-start;gap:12px}",
				".rcl-head-text{flex:auto;min-width:0}",
				".rcl-title{margin:0;font-size:18px;font-weight:600;line-height:26px}",
				".rcl-sub{margin:2px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}",
				".rcl-actions{display:flex;align-items:center;gap:8px;flex:none}",
				".rcl-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 12px;font-size:13px;line-height:20px;cursor:pointer}",
				".rcl-btn:hover{border-color:var(--dsw-alias-brand-primary)}",
				".rcl-btn[disabled]{opacity:.55;cursor:default}",
				".rcl-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}",
				".rcl-card{display:flex;flex-direction:column;gap:2px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}",
				".rcl-kpi{font-size:21px;font-weight:600;line-height:28px;font-variant-numeric:tabular-nums}",
				".rcl-kpi-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
				".rcl-kpi-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}",
				".rcl-bar{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}",
				".rcl-bar-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .3s ease}",
				".rcl-block{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}",
				".rcl-block-title{font-size:13px;font-weight:600;line-height:20px}",
				".rcl-rowline{display:flex;align-items:center;gap:12px;min-height:28px;font-size:13px;line-height:20px}",
				".rcl-rowline-label{flex:none;width:112px;color:var(--dsw-alias-label-secondary)}",
				".rcl-rowline-value{flex:auto;min-width:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
				".rcl-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}",
				".rcl-dot{width:7px;height:7px;border-radius:999px;flex:none}",
				".rcl-ok{background:var(--dsw-alias-state-success-primary)}",
				".rcl-idle{background:var(--dsw-alias-state-idle-primary)}",
				".rcl-warn{background:var(--dsw-alias-state-warn-primary)}",
				".rcl-switch{position:relative;flex:none;width:36px;height:20px;padding:0;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer}",
				".rcl-switch[aria-checked=\"true\"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}",
				".rcl-switch::after{content:\"\";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:999px;background:#fff;transition:transform .15s ease}",
				".rcl-switch[aria-checked=\"true\"]::after{transform:translateX(16px)}",
				".rcl-switch[disabled]{opacity:.5;cursor:default}",
				".rcl-select{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:3px 8px;font-size:13px;line-height:20px}",
				".rcl-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
				".rcl-err{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}",
			].join("");
			document.head.appendChild(tag);
		}

		// ── i18n ────────────────────────────────────────────────────────────
		var NS = "recall";
		var dictionaries = {
			zh: {
				recalling: "回忆中…",
				done: "回忆完成",
				failed: "回忆失败",
				settingsLabel: "Recall 记忆",
				title: "记忆状态",
				subtitle: "本地对话记忆索引 · 完全离线",
				sessions: "会话",
				docs: "记忆条数",
				coverage: "语义覆盖",
				size: "索引大小",
				vectors: "向量",
				pending: "待嵌入",
				lastIndexed: "最近入库",
				model: "语义模型",
				modelReady: "可用",
				modelMissing: "未找到模型",
				warmup: "后台预热",
				warmupFast: "快速",
				warmupGentle: "轻柔",
				anchor: "压缩锚点",
				on: "开",
				off: "关",
				lastRecall: "最近召回",
				never: "尚未调用",
				calls: "累计召回",
				errors: "失败",
				indexPath: "索引文件",
				ftsPath: "官方 FTS",
				settingsPath: "设置文件",
				refresh: "刷新",
				loading: "读取中…",
				unavailable: "无法连接宿主统计接口。请确认 dsh-recall 插件已启用、dsh web 已完整启动，然后点击「刷新」重试。",
				settings: "设置",
				settingsHint: "修改立即生效，无需重启。",
				autoNote: "每 5 秒自动刷新",
				noIndex: "索引尚未建立：第一次 recall 时自动创建。",
			},
			en: {
				recalling: "Recalling…",
				done: "Recall complete",
				failed: "Recall failed",
				settingsLabel: "Recall memory",
				title: "Memory status",
				subtitle: "Local conversation memory index · fully offline",
				sessions: "Sessions",
				docs: "Memories",
				coverage: "Semantic coverage",
				size: "Index size",
				vectors: "Vectors",
				pending: "Pending",
				lastIndexed: "Last indexed",
				model: "Semantic model",
				modelReady: "available",
				modelMissing: "model missing",
				warmup: "Background warm-up",
				warmupFast: "Fast",
				warmupGentle: "Gentle",
				anchor: "Compaction anchor",
				on: "On",
				off: "Off",
				lastRecall: "Last recall",
				never: "not called yet",
				calls: "Total recalls",
				errors: "failures",
				indexPath: "Index file",
				ftsPath: "Official FTS",
				settingsPath: "Settings file",
				refresh: "Refresh",
				loading: "Loading…",
				unavailable: "Cannot reach the Host stats endpoint. Check that the dsh-recall plugin is enabled and dsh web finished starting, then press Refresh.",
				settings: "Settings",
				settingsHint: "Changes apply immediately; no restart needed.",
				autoNote: "Refreshes every 5 seconds",
				noIndex: "No index yet: it is created on the first recall.",
			},
		};

		var tRef = null;

		// ── helpers ─────────────────────────────────────────────────────────
		function h(type, props) {
			var args = [type, props];
			for (var i = 2; i < arguments.length; i++) args.push(arguments[i]);
			return React.createElement.apply(React, args);
		}

		function formatBytes(bytes) {
			if (typeof bytes !== "number" || !isFinite(bytes)) return "—";
			if (bytes < 1024) return bytes + " B";
			if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
			return (bytes / (1024 * 1024)).toFixed(1) + " MB";
		}

		function formatTime(ms) {
			if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return "—";
			try {
				return new Date(ms).toLocaleString();
			} catch (error) {
				return "—";
			}
		}

		function formatPercent(value) {
			if (typeof value !== "number" || !isFinite(value)) return "—";
			return Math.round(Math.max(0, Math.min(1, value)) * 100) + "%";
		}

		// Home-rooted display for the two absolute DB paths (`C:\Users\<name>` → `~`).
		function homeShort(path) {
			var text = String(path || "");
			if (text === "") return "—";
			return text.replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~").replace(/^\/home\/[^/]+/, "~");
		}

		// ── Tool row ────────────────────────────────────────────────────────
		// tool.call.toolview owner props: { callId, toolName, phase, block, cwd,
		// home, openFile, loadImage, inspect, useDisclosure } + t
		function RecallToolView(props) {
			// The slot shell may or may not inject `t`; fall back to the apply-time
			// bound translator.
			var t = (props && props.t) || tRef || (function (key) { return key; });
			var block = props && props.block;
			var settled = !!props && props.phase === "result";
			var isError = settled && !!block && !!block.isError;
			var errorText = "";
			if (isError && block.error) {
				errorText = String(block.error.name || "") + (block.error.code ? ": " + block.error.code : "");
			}
			var icon = h("svg", { className: "rcl-icon", viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
				h("path", { d: "M8 2a5 5 0 1 0 4.9 6.5", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }),
				h("path", { d: "M8 5v3l2 1.5", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }));
			var cls = "rcl-row" + (settled ? (isError ? " rcl-error" : " rcl-done") : " rcl-recalling");
			var text = settled ? (isError ? t("failed") + (errorText !== "" ? " · " + errorText : "") : t("done")) : t("recalling");
			return h("div", { className: cls },
				icon,
				h("span", { className: "rcl-text" }, text));
		}

		// ── Settings section ────────────────────────────────────────────────
		var useState = React.useState;
		var useEffect = React.useEffect;

		function row(label, value) {
			return h("div", { className: "rcl-rowline" },
				h("span", { className: "rcl-rowline-label" }, label),
				h("span", { className: "rcl-rowline-value" }, value));
		}

		function RecallSettingsPage(props) {
			var t = (props && props.t) || tRef || (function (key) { return key; });
			var state = useState({ loading: true, error: "", data: null, busy: false });
			var current = state[0];
			var setState = state[1];

			function load() {
				if (typeof fetch !== "function") return;
				fetch("/recall/stats", { headers: { accept: "application/json" }, credentials: "same-origin" })
					.then(function (response) {
						if (!response.ok) throw new Error("HTTP " + response.status);
						return response.json();
					})
					.then(function (data) {
						setState({ loading: false, error: "", data: data, busy: false });
					})
					.catch(function (error) {
						setState({
							loading: false,
							error: String((error && error.message) || error),
							data: null,
							busy: false,
						});
					});
			}

			useEffect(function () {
				load();
				var timer = setInterval(load, 5000);
				return function () {
					clearInterval(timer);
				};
			}, []);

			function update(patch) {
				if (typeof fetch !== "function") return;
				setState(function (previous) {
					return {
						loading: previous.loading,
						error: previous.error,
						data: previous.data,
						busy: true,
					};
				});
				fetch("/recall/settings", {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					credentials: "same-origin",
					body: JSON.stringify(patch),
				})
					.then(function (response) {
						if (!response.ok) throw new Error("HTTP " + response.status);
						return response.json();
					})
					.then(function (data) {
						setState({ loading: false, error: "", data: data, busy: false });
					})
					.catch(function (error) {
						setState(function (previous) {
							return {
								loading: false,
								error: String((error && error.message) || error),
								data: previous.data,
								busy: false,
							};
						});
					});
			}

			var data = current.data;
			var settings = data && data.settings ? data.settings : null;
			var index = data && data.index ? data.index : null;
			var fts = data && data.fts ? data.fts : null;
			var runtime = data && data.runtime ? data.runtime : null;
			var recall = data && data.recall ? data.recall : null;
			var modelReady = !!(runtime && runtime.modelAvailable);

			var header = h("div", { className: "rcl-head" },
				h("div", { className: "rcl-head-text" },
					h("h2", { className: "rcl-title" }, t("title")),
					h("p", { className: "rcl-sub" }, t("subtitle") + " · " + t("autoNote"))),
				h("div", { className: "rcl-actions" },
					h("button", { className: "rcl-btn", type: "button", onClick: load, disabled: current.busy }, t("refresh"))));

			if (current.error) {
				return h("div", { className: "rcl-page" },
					header,
					h("div", { className: "rcl-block" },
						h("div", { className: "rcl-err" }, t("unavailable")),
						h("div", { className: "rcl-note" }, current.error)));
			}

			if (!data) {
				return h("div", { className: "rcl-page" }, header,
					h("div", { className: "rcl-note" }, t("loading")));
			}

			var stats = h("div", { className: "rcl-grid" },
				h("div", { className: "rcl-card" },
					h("span", { className: "rcl-kpi" }, index ? String(index.sessions) : "—"),
					h("span", { className: "rcl-kpi-label" }, t("sessions"))),
				h("div", { className: "rcl-card" },
					h("span", { className: "rcl-kpi" }, index ? String(index.docs) : "—"),
					h("span", { className: "rcl-kpi-label" }, t("docs")),
					h("span", { className: "rcl-kpi-note" }, index ? t("lastIndexed") + " " + formatTime(index.lastDocTime) : "")),
				h("div", { className: "rcl-card" },
					h("span", { className: "rcl-kpi" }, index ? formatPercent(index.coverage) : "—"),
					h("span", { className: "rcl-kpi-label" }, t("coverage")),
					h("span", { className: "rcl-kpi-note" }, index ? index.vectors + " / " + index.docs : "")),
				h("div", { className: "rcl-card" },
					h("span", { className: "rcl-kpi" }, index ? formatBytes(index.bytes) : "—"),
					h("span", { className: "rcl-kpi-label" }, t("size"))));

			var coverage = index && typeof index.coverage === "number" ? index.coverage : 0;
			var bar = h("div", { className: "rcl-bar" },
				h("div", { className: "rcl-bar-fill", style: { width: Math.round(Math.max(0, Math.min(1, coverage)) * 100) + "%" } }));

			var memory = h("div", { className: "rcl-block" },
				h("div", { className: "rcl-block-title" }, t("title")),
				stats,
				bar,
				index && index.docs === 0 ? h("div", { className: "rcl-note" }, t("noIndex")) : null,
				row(t("vectors"), index ? index.vectors + " · " + t("pending") + " " + index.pending : "—"),
				row(t("model"), h("span", { className: "rcl-rowline-value" },
					h("span", { className: "rcl-dot " + (modelReady ? "rcl-ok" : "rcl-warn") }),
					h("span", null, modelReady ? t("modelReady") : t("modelMissing")))),
				row(t("lastRecall"), recall && recall.lastAt
					? formatTime(recall.lastAt) + " · " + recall.lastMs + "ms · \"" + recall.lastQuery + "\""
					: t("never")),
				row(t("calls"), recall ? String(recall.calls) + " · " + t("errors") + " " + String(recall.errors) : "—"));

			var controls = h("div", { className: "rcl-block" },
				h("div", { className: "rcl-block-title" }, t("settings")),
				h("div", { className: "rcl-rowline" },
					h("span", { className: "rcl-rowline-label" }, t("model")),
					h("span", { className: "rcl-rowline-value" },
						h("button", {
							type: "button",
							className: "rcl-switch",
							role: "switch",
							"aria-checked": settings && settings.semantic ? "true" : "false",
							"aria-label": t("model"),
							disabled: current.busy || !modelReady,
							onClick: function () { update({ semantic: !(settings && settings.semantic) }); },
						}),
						h("span", { className: "rcl-note" }, settings && settings.semantic ? t("on") : t("off")))),
				h("div", { className: "rcl-rowline" },
					h("span", { className: "rcl-rowline-label" }, t("warmup")),
					h("span", { className: "rcl-rowline-value" },
						h("select", {
							className: "rcl-select",
							value: settings ? settings.warmup : "fast",
							disabled: current.busy,
							onChange: function (event) { update({ warmup: event.target.value }); },
						},
							h("option", { value: "fast" }, t("warmupFast")),
							h("option", { value: "gentle" }, t("warmupGentle"))))),
				h("div", { className: "rcl-rowline" },
					h("span", { className: "rcl-rowline-label" }, t("anchor")),
					h("span", { className: "rcl-rowline-value" },
						h("button", {
							type: "button",
							className: "rcl-switch",
							role: "switch",
							"aria-checked": settings && settings.anchor ? "true" : "false",
							"aria-label": t("anchor"),
							disabled: current.busy,
							onClick: function () { update({ anchor: !(settings && settings.anchor) }); },
						}),
						h("span", { className: "rcl-note" }, settings && settings.anchor ? t("on") : t("off")))),
				h("div", { className: "rcl-note" }, t("settingsHint")));

			var files = h("div", { className: "rcl-block" },
				h("div", { className: "rcl-block-title" }, "Files"),
				row(t("indexPath"), h("span", { className: "rcl-mono" }, homeShort(index && index.path))),
				row(t("ftsPath"), h("span", { className: "rcl-mono" },
					homeShort(fts && fts.path) + " · " + formatBytes(fts && fts.bytes))),
				row(t("settingsPath"), h("span", { className: "rcl-mono" }, homeShort(index && index.settingsPath))));

			return h("div", { className: "rcl-page" }, header, memory, controls, files);
		}

		// ── plugin face ─────────────────────────────────────────────────────
		var inject = ["slots", "locale"];
		async function apply(ctx) {
			ctx.locale.register(NS, dictionaries);
			tRef = ctx.locale.bind(NS);
			ctx.slots.inject("tool.call.toolview", function* () {
				yield ctx.slots.register({
					name: "tool.call.toolview",
					key: "recall",
					locale: NS,
				}, RecallToolView);
			});
			ctx.slots.inject("settings.section", function* () {
				yield ctx.slots.register({
					name: "settings.section",
					id: "dsh-recall",
					order: 60,
					label: function () { return tRef("settingsLabel"); },
					locale: NS,
				}, RecallSettingsPage);
			});
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
