var O = Object.defineProperty;
var F = (n, e, o) => e in n ? O(n, e, { enumerable: !0, configurable: !0, writable: !0, value: o }) : n[e] = o;
var y = (n, e, o) => F(n, typeof e != "symbol" ? e + "" : e, o);
import { defineComponent as $, openBlock as p, createElementBlock as m, createElementVNode as t, Fragment as k, renderList as w, toDisplayString as f, computed as M, createCommentVNode as b, withDirectives as g, vModelSelect as R, createVNode as U, vModelText as x, createBlock as P, renderSlot as B, createTextVNode as E, normalizeClass as C, ref as I, createStaticVNode as j, withModifiers as z } from "vue";
class L extends Error {
}
class J extends Error {
}
class W extends Error {
}
class Q extends Error {
}
class Y extends Error {
}
class G extends Error {
}
class A extends Error {
}
class T extends Error {
}
class H extends Error {
}
class K extends Error {
}
const X = {
  string: (n) => typeof n == "string",
  int: (n) => Number.isInteger(n) && typeof n != "boolean",
  float: (n) => typeof n == "number" && typeof n != "boolean",
  bool: (n) => typeof n == "boolean",
  file_path: (n) => typeof n == "string",
  json_object: (n) => typeof n == "object" && n !== null && !Array.isArray(n),
  list: (n) => Array.isArray(n)
};
class at {
  constructor(e) {
    y(this, "workflows", /* @__PURE__ */ new Map());
    y(this, "instanceSchemas", /* @__PURE__ */ new Map());
    y(this, "runtimeAdapters", /* @__PURE__ */ new Map());
    y(this, "executionRuntimes", /* @__PURE__ */ new Map());
    y(this, "skillSchemas", /* @__PURE__ */ new Map());
    y(this, "types", /* @__PURE__ */ new Map());
    y(this, "authorizationCheck", null);
    y(this, "plans", /* @__PURE__ */ new Map());
    y(this, "runStore");
    this.runStore = e.runStore;
    for (const [o, s] of Object.entries(X))
      this.types.set(o, s);
  }
  registerWorkflow(e, o) {
    this.workflows.set(e, o);
  }
  registerInstanceSchema(e, o) {
    this.instanceSchemas.set(e, o);
  }
  registerRuntimeAdapter(e, o) {
    if (typeof o.handler != "function")
      throw new Error("adapter 必含 handler 函数");
    if (!Array.isArray(o.query_types_whitelist))
      throw new Error("adapter 必含 query_types_whitelist (declarative 安全)");
    this.runtimeAdapters.set(e, o);
  }
  registerExecutionRuntime(e, o) {
    if (typeof o.run_skill != "function")
      throw new Error("runtime 必含 run_skill 函数");
    this.executionRuntimes.set(e, o);
  }
  registerType(e, o) {
    this.types.set(e, o);
  }
  registerSkillSchema(e, o) {
    this.skillSchemas.set(e, o);
  }
  setAuthorizationCheck(e) {
    this.authorizationCheck = e;
  }
  listSkills() {
    return Array.from(this.skillSchemas.keys());
  }
  getSkillSchema(e) {
    const o = this.skillSchemas.get(e);
    if (!o) throw new H(`unknown skill: ${e}`);
    return o;
  }
  validateType(e, o) {
    const s = this.types.get(e);
    if (!s) throw new Error(`未注册类型: ${e}`);
    return s(o);
  }
  async planTrigger(e) {
    if (!e.triggeredBy)
      throw new L("triggered_by 必填 — 永不自动触发铁律强制");
    const o = this.workflows.get(e.workflowId);
    if (!o) throw new Error(`unknown workflow: ${e.workflowId}`);
    const s = this.findNode(o, e.nodeId), i = [], c = /* @__PURE__ */ new Set(), d = /* @__PURE__ */ new Set();
    await this.buildChain(o, s, e.instanceId, i, c, d);
    for (const l of s.inputs || [])
      if (l.required && l.source.kind === "trigger_param" && !(l.name in e.triggerInputs))
        throw new J(`node ${e.nodeId} 必填 trigger_param: ${l.name}`);
    const a = Z(), r = {
      plan_id: a,
      workflow_id: e.workflowId,
      instance_id: e.instanceId,
      root_node_id: e.nodeId,
      trigger_inputs: e.triggerInputs,
      triggered_by: e.triggeredBy,
      instance_data: e.instanceData ?? {},
      dependency_chain: i,
      skill_prechecks: [],
      estimated_duration_sec: i.reduce((l, u) => {
        var h;
        const _ = this.skillSchemas.get(u.skill_id);
        return l + (((h = _ == null ? void 0 : _.metadata) == null ? void 0 : h.estimated_duration_sec) ?? 0);
      }, 0),
      expires_at: new Date(Date.now() + 5 * 60 * 1e3).toISOString()
    };
    return this.plans.set(a, r), r;
  }
  findNode(e, o) {
    const s = e.nodes.find((i) => i.id === o);
    if (!s) throw new Error(`unknown node_id: ${o} in workflow ${e.id}`);
    return s;
  }
  async buildChain(e, o, s, i, c, d) {
    const a = o.id;
    if (!d.has(a)) {
      if (c.has(a))
        throw new W(`循环依赖: ${a}`);
      c.add(a);
      for (const r of o.inputs || [])
        if (r.source.kind === "upstream_node" && r.source.node_id) {
          const l = this.findNode(e, r.source.node_id), u = await this.runStore.queryLatestSuccess({
            workflow_id: e.id,
            instance_id: s,
            node_id: l.id
          });
          if (u === null)
            await this.buildChain(e, l, s, i, c, d);
          else if (u.status === "failed")
            throw new Q(`上游 ${l.id} 最近运行失败`);
        }
      i.push({
        node_id: a,
        skill_id: o.skill_id,
        kind: o.kind,
        will_run: !0,
        reason: "scheduled"
      }), c.delete(a), d.add(a);
    }
  }
  async confirmAndRun(e) {
    const o = this.plans.get(e);
    if (!o) throw new Error(`unknown or expired plan_id: ${e}`);
    if ((/* @__PURE__ */ new Date()).toISOString() > o.expires_at)
      throw new K("plan expired (5 min TTL)");
    if (this.authorizationCheck && !await this.authorizationCheck(o.triggered_by, o))
      throw new Error("RBAC check failed");
    let s = null;
    for (const i of o.dependency_chain)
      s = await this.executeNode(o, i);
    if (!s) throw new Error("plan dependency_chain 空");
    return s;
  }
  async executeNode(e, o) {
    const s = this.workflows.get(e.workflow_id), i = this.findNode(s, o.node_id), c = await this.runStore.queryRunning({
      workflow_id: e.workflow_id,
      instance_id: e.instance_id,
      node_id: i.id
    });
    if (c)
      throw new Y(`node ${i.id} 已有 running run: ${c.run_id}`);
    const d = await this.resolveInputs(e, i, s), a = {
      inputs: i.inputs ?? [],
      outputs: i.outputs ?? [],
      skill_id: i.skill_id
    }, r = await this.runStore.writePending({
      workflow_id: e.workflow_id,
      instance_id: e.instance_id,
      node_id: i.id,
      skill_id: i.skill_id,
      inputs: d,
      triggered_by: e.triggered_by,
      template_version: s.version ?? "v1",
      node_schema_snapshot: a
    });
    if (await this.runStore.writeRunning(r), i.kind === "manual")
      return this.runStore.getRecord(r);
    const l = this.skillSchemas.get(i.skill_id), u = l == null ? void 0 : l.runtime, _ = u ? this.executionRuntimes.get(u) : void 0;
    if (!_)
      throw await this.runStore.writeFailed(r, { error_message: `unknown runtime: ${u}` }), new G(u ?? "<undefined>");
    const h = {
      workflow_id: e.workflow_id,
      instance_id: e.instance_id,
      instance_data: e.instance_data,
      node_id: i.id,
      run_id: r,
      triggered_by: e.triggered_by
    }, D = Date.now();
    try {
      const v = await _.run_skill(i.skill_id, d, h), N = (Date.now() - D) / 1e3, V = this.summarizeOutputs(v, i);
      await this.runStore.writeSuccess(r, {
        outputs: v,
        outputs_summary: V,
        duration_sec: N
      });
    } catch (v) {
      const N = v instanceof Error ? v.message : String(v), V = v instanceof Error ? v.stack ?? "" : "";
      await this.runStore.writeFailed(r, { error_message: N, traceback: V });
    }
    return this.runStore.getRecord(r);
  }
  async resolveInputs(e, o, s) {
    const i = {};
    for (const c of o.inputs || []) {
      const d = c.source;
      if (d.kind === "trigger_param")
        i[c.name] = e.trigger_inputs[c.name] ?? d.default;
      else if (d.kind === "upstream_node" && d.node_id && d.output_name) {
        const a = await this.runStore.queryLatestSuccess({
          workflow_id: e.workflow_id,
          instance_id: e.instance_id,
          node_id: d.node_id
        });
        a != null && a.outputs_summary && (i[c.name] = a.outputs_summary[d.output_name]);
      } else if (d.kind === "instance_data" && d.path) {
        let a = e.instance_data;
        for (const r of d.path.split("."))
          a = a[r];
        i[c.name] = a;
      } else if (d.kind === "runtime_adapter" && d.adapter_id) {
        const a = this.runtimeAdapters.get(d.adapter_id);
        if (!a) throw new A(`unknown adapter: ${d.adapter_id}`);
        const r = d.query ?? {};
        if (typeof r.type != "string")
          throw new Error("runtime_adapter query 必含 type 字段");
        if (!a.query_types_whitelist.includes(r.type))
          throw new T(
            `adapter ${d.adapter_id} query type '${r.type}' not in whitelist`
          );
        i[c.name] = await a.handler(r, { instance_id: e.instance_id });
      }
    }
    return i;
  }
  summarizeOutputs(e, o) {
    const s = {};
    for (const i of o.outputs || []) {
      const c = e[i.name];
      if (c !== void 0)
        if (typeof c == "string" || typeof c == "number" || typeof c == "boolean" || Array.isArray(c) && c.length <= 10)
          s[i.name] = c;
        else {
          const d = Array.isArray(c) || typeof c == "object" && c !== null && "length" in c ? c.length : "?";
          s[i.name] = `<${typeof c} len=${d}>`;
        }
    }
    return s;
  }
  async cancelRun(e) {
    return await this.runStore.requestCancel(e), !0;
  }
  async checkpoint(e) {
    return e.run_id ? this.runStore.isCancelRequested(e.run_id) : !1;
  }
  async queryRuntime(e, o, s) {
    const i = this.runtimeAdapters.get(e);
    if (!i) throw new A(`unknown adapter: ${e}`);
    if (typeof o.type != "string")
      throw new Error("query 必含 type 字段 (declarative)");
    if (!i.query_types_whitelist.includes(o.type))
      throw new T(
        `adapter ${e} query type '${o.type}' not in whitelist`
      );
    return i.handler(o, s);
  }
  async getRunRecord(e) {
    return this.runStore.getRecord(e);
  }
}
function Z() {
  return typeof crypto < "u" && typeof crypto.randomUUID == "function" ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (n) => {
    const e = Math.random() * 16 | 0;
    return (n === "x" ? e : e & 3 | 8).toString(16);
  });
}
const ee = ["value"], te = ["value"], ne = /* @__PURE__ */ $({
  __name: "SkillPicker",
  props: {
    modelValue: {},
    skills: {}
  },
  emits: ["update:modelValue"],
  setup(n, { emit: e }) {
    const o = e;
    function s(i) {
      o("update:modelValue", i.target.value);
    }
    return (i, c) => (p(), m("select", {
      value: n.modelValue,
      onChange: s
    }, [
      c[0] || (c[0] = t("option", {
        value: "",
        disabled: ""
      }, "(选 skill)", -1)),
      (p(!0), m(k, null, w(n.skills, (d) => (p(), m("option", {
        key: d,
        value: d
      }, f(d), 9, te))), 128))
    ], 40, ee));
  }
}), oe = ["value"], ie = ["value"], q = /* @__PURE__ */ $({
  __name: "TypePicker",
  props: {
    modelValue: {},
    types: {}
  },
  emits: ["update:modelValue"],
  setup(n, { emit: e }) {
    const o = e;
    function s(i) {
      o("update:modelValue", i.target.value);
    }
    return (i, c) => (p(), m("select", {
      value: n.modelValue,
      onChange: s
    }, [
      (p(!0), m(k, null, w(n.types, (d) => (p(), m("option", {
        key: d,
        value: d
      }, f(d), 9, ie))), 128))
    ], 40, oe));
  }
}), se = { class: "upstream-picker" }, re = ["value"], ae = ["value"], le = ["value"], ue = ["value"], de = /* @__PURE__ */ $({
  __name: "UpstreamNodePicker",
  props: {
    nodeId: {},
    outputName: {},
    workflow: {}
  },
  emits: ["update:nodeId", "update:outputName"],
  setup(n, { emit: e }) {
    const o = n, s = e, i = M(() => {
      if (!o.nodeId) return [];
      const a = o.workflow.nodes.find((r) => r.id === o.nodeId);
      return (a == null ? void 0 : a.outputs) ?? [];
    });
    function c(a) {
      s("update:nodeId", a.target.value), s("update:outputName", "");
    }
    function d(a) {
      s("update:outputName", a.target.value);
    }
    return (a, r) => (p(), m("span", se, [
      t("select", {
        value: n.nodeId,
        onChange: c
      }, [
        r[0] || (r[0] = t("option", {
          value: "",
          disabled: ""
        }, "(选上游节点)", -1)),
        (p(!0), m(k, null, w(n.workflow.nodes, (l) => (p(), m("option", {
          key: l.id,
          value: l.id
        }, f(l.id) + " (" + f(l.name) + ")", 9, ae))), 128))
      ], 40, re),
      n.nodeId ? (p(), m("select", {
        key: 0,
        value: n.outputName,
        onChange: d
      }, [
        r[1] || (r[1] = t("option", {
          value: "",
          disabled: ""
        }, "(选输出)", -1)),
        (p(!0), m(k, null, w(i.value, (l) => (p(), m("option", {
          key: l.name,
          value: l.name
        }, f(l.name) + " : " + f(l.type), 9, ue))), 128))
      ], 40, le)) : b("", !0)
    ]));
  }
}), S = (n, e) => {
  const o = n.__vccOpts || n;
  for (const [s, i] of e)
    o[s] = i;
  return o;
}, ce = /* @__PURE__ */ S(de, [["__scopeId", "data-v-dc279ee9"]]), pe = { class: "ae-node-editor" }, me = { class: "field" }, fe = { class: "field" }, _e = { class: "section" }, he = ["onUpdate:modelValue"], ye = ["onUpdate:modelValue"], ke = ["onClick"], we = { class: "section" }, ve = ["onUpdate:modelValue"], ge = ["onUpdate:modelValue"], be = ["onClick"], $e = { class: "actions" }, xe = /* @__PURE__ */ $({
  __name: "NodeEditor",
  props: {
    node: {},
    workflow: {},
    availableSkills: {},
    availableTypes: {}
  },
  emits: ["save", "cancel"],
  setup(n) {
    const e = n;
    function o() {
      e.node.inputs || (e.node.inputs = []), e.node.inputs.push({
        name: "",
        type: "string",
        required: !1,
        source: { kind: "trigger_param" }
      });
    }
    function s(d) {
      var a;
      (a = e.node.inputs) == null || a.splice(d, 1);
    }
    function i() {
      e.node.outputs || (e.node.outputs = []), e.node.outputs.push({ name: "", type: "string", description: "" });
    }
    function c(d) {
      var a;
      (a = e.node.outputs) == null || a.splice(d, 1);
    }
    return (d, a) => (p(), m("div", pe, [
      t("h3", null, f(n.node.name || "(未命名节点)"), 1),
      t("div", me, [
        a[5] || (a[5] = t("label", null, "自动化:", -1)),
        g(t("select", {
          "onUpdate:modelValue": a[0] || (a[0] = (r) => n.node.kind = r)
        }, [...a[4] || (a[4] = [
          t("option", { value: "automated" }, "automated", -1),
          t("option", { value: "manual" }, "manual", -1)
        ])], 512), [
          [R, n.node.kind]
        ])
      ]),
      t("div", fe, [
        a[6] || (a[6] = t("label", null, "Skill:", -1)),
        U(ne, {
          modelValue: n.node.skill_id,
          "onUpdate:modelValue": a[1] || (a[1] = (r) => n.node.skill_id = r),
          skills: n.availableSkills
        }, null, 8, ["modelValue", "skills"])
      ]),
      t("div", _e, [
        a[8] || (a[8] = t("h4", null, "输入", -1)),
        (p(!0), m(k, null, w(n.node.inputs, (r, l) => (p(), m("div", {
          key: l,
          class: "input-row"
        }, [
          g(t("input", {
            "onUpdate:modelValue": (u) => r.name = u,
            placeholder: "name"
          }, null, 8, he), [
            [x, r.name]
          ]),
          U(q, {
            modelValue: r.type,
            "onUpdate:modelValue": (u) => r.type = u,
            types: n.availableTypes
          }, null, 8, ["modelValue", "onUpdate:modelValue", "types"]),
          g(t("select", {
            "onUpdate:modelValue": (u) => r.source.kind = u
          }, [...a[7] || (a[7] = [
            t("option", { value: "trigger_param" }, "触发参数", -1),
            t("option", { value: "upstream_node" }, "上游节点", -1),
            t("option", { value: "instance_data" }, "instance 字段", -1),
            t("option", { value: "runtime_adapter" }, "运行时 adapter", -1)
          ])], 8, ye), [
            [R, r.source.kind]
          ]),
          r.source.kind === "upstream_node" ? (p(), P(ce, {
            key: 0,
            nodeId: r.source.node_id,
            "onUpdate:nodeId": (u) => r.source.node_id = u,
            outputName: r.source.output_name,
            "onUpdate:outputName": (u) => r.source.output_name = u,
            workflow: n.workflow
          }, null, 8, ["nodeId", "onUpdate:nodeId", "outputName", "onUpdate:outputName", "workflow"])) : b("", !0),
          t("button", {
            type: "button",
            onClick: (u) => s(l)
          }, "删", 8, ke)
        ]))), 128)),
        t("button", {
          type: "button",
          onClick: o
        }, "+ 加输入")
      ]),
      t("div", we, [
        a[9] || (a[9] = t("h4", null, "输出", -1)),
        (p(!0), m(k, null, w(n.node.outputs, (r, l) => (p(), m("div", {
          key: l,
          class: "output-row"
        }, [
          g(t("input", {
            "onUpdate:modelValue": (u) => r.name = u,
            placeholder: "name"
          }, null, 8, ve), [
            [x, r.name]
          ]),
          U(q, {
            modelValue: r.type,
            "onUpdate:modelValue": (u) => r.type = u,
            types: n.availableTypes
          }, null, 8, ["modelValue", "onUpdate:modelValue", "types"]),
          g(t("input", {
            "onUpdate:modelValue": (u) => r.description = u,
            placeholder: "描述"
          }, null, 8, ge), [
            [x, r.description]
          ]),
          t("button", {
            type: "button",
            onClick: (u) => c(l)
          }, "删", 8, be)
        ]))), 128)),
        t("button", {
          type: "button",
          onClick: i
        }, "+ 加输出")
      ]),
      t("div", $e, [
        B(d.$slots, "extra-actions", {}, void 0, !0),
        t("button", {
          type: "button",
          onClick: a[2] || (a[2] = (r) => d.$emit("save", n.node))
        }, "保存"),
        t("button", {
          type: "button",
          onClick: a[3] || (a[3] = (r) => d.$emit("cancel"))
        }, "取消")
      ])
    ]));
  }
}), lt = /* @__PURE__ */ S(xe, [["__scopeId", "data-v-3f7fe700"]]), Se = { class: "ae-execution-plan" }, Ee = { class: "meta" }, Ie = { class: "chain" }, Ce = { class: "step" }, Ne = { class: "node-id" }, Ve = { class: "skill" }, Ue = { class: "reason" }, Re = {
  key: 0,
  class: "prechecks"
}, Ae = { class: "actions" }, Te = ["disabled"], qe = ["disabled"], Me = {
  key: 1,
  class: "error"
}, De = /* @__PURE__ */ $({
  __name: "ExecutionPlan",
  props: {
    plan: {},
    busy: { type: Boolean },
    errorMessage: {}
  },
  emits: ["confirm", "cancel"],
  setup(n) {
    function e(o) {
      return new Date(o).toLocaleString();
    }
    return (o, s) => (p(), m("div", Se, [
      s[7] || (s[7] = t("h3", null, "执行计划", -1)),
      t("div", Ee, [
        t("div", null, [
          s[2] || (s[2] = t("b", null, "触发节点:", -1)),
          E(" " + f(n.plan.root_node_id), 1)
        ]),
        t("div", null, [
          s[3] || (s[3] = t("b", null, "触发人:", -1)),
          E(" " + f(n.plan.triggered_by), 1)
        ]),
        t("div", null, [
          s[4] || (s[4] = t("b", null, "预计耗时:", -1)),
          E(" " + f(n.plan.estimated_duration_sec) + "s", 1)
        ]),
        t("div", null, [
          s[5] || (s[5] = t("b", null, "计划过期:", -1)),
          E(" " + f(e(n.plan.expires_at)), 1)
        ])
      ]),
      s[8] || (s[8] = t("h4", null, "依赖链 (拓扑序)", -1)),
      t("ol", Ie, [
        (p(!0), m(k, null, w(n.plan.dependency_chain, (i, c) => (p(), m("li", {
          key: i.node_id,
          class: C({ root: i.node_id === n.plan.root_node_id })
        }, [
          t("span", Ce, f(c + 1) + ".", 1),
          t("span", Ne, f(i.node_id), 1),
          t("span", {
            class: C(["kind", i.kind])
          }, f(i.kind), 3),
          t("span", Ve, "[skill: " + f(i.skill_id) + "]", 1),
          t("span", Ue, f(i.reason), 1)
        ], 2))), 128))
      ]),
      n.plan.skill_prechecks.length > 0 ? (p(), m("div", Re, [
        s[6] || (s[6] = t("h4", null, "Precheck 警告", -1)),
        t("ul", null, [
          (p(!0), m(k, null, w(n.plan.skill_prechecks, (i, c) => (p(), m("li", { key: c }, f(JSON.stringify(i)), 1))), 128))
        ])
      ])) : b("", !0),
      t("div", Ae, [
        t("button", {
          type: "button",
          disabled: n.busy,
          onClick: s[0] || (s[0] = (i) => o.$emit("confirm", n.plan.plan_id))
        }, f(n.busy ? "执行中…" : "✓ 确认执行"), 9, Te),
        t("button", {
          type: "button",
          disabled: n.busy,
          onClick: s[1] || (s[1] = (i) => o.$emit("cancel"))
        }, "取消", 8, qe)
      ]),
      n.errorMessage ? (p(), m("div", Me, f(n.errorMessage), 1)) : b("", !0)
    ]));
  }
}), ut = /* @__PURE__ */ S(De, [["__scopeId", "data-v-a67ffad3"]]), Oe = { class: "ae-audit-view" }, Fe = { class: "header" }, Pe = { class: "filters" }, Be = { class: "stats" }, je = { class: "pill success" }, ze = { class: "pill failed" }, Le = { class: "pill running" }, Je = ["onClick"], We = ["onClick"], Qe = { key: 0 }, Ye = /* @__PURE__ */ $({
  __name: "AuditView",
  props: {
    runs: {}
  },
  emits: ["view-detail", "cancel"],
  setup(n) {
    const e = n, o = I(""), s = I(""), i = I(""), c = M(
      () => e.runs.filter(
        (r) => (!o.value || r.status === o.value) && (!s.value || r.instance_id.includes(s.value)) && (!i.value || r.node_id.includes(i.value))
      )
    );
    function d(r) {
      return e.runs.filter((l) => l.status === r).length;
    }
    function a(r) {
      return new Date(r).toLocaleString();
    }
    return (r, l) => (p(), m("div", Oe, [
      t("div", Fe, [
        l[4] || (l[4] = t("h3", null, "审计日志 (nodeRuns)", -1)),
        t("div", Pe, [
          g(t("select", {
            "onUpdate:modelValue": l[0] || (l[0] = (u) => o.value = u)
          }, [...l[3] || (l[3] = [
            j('<option value="" data-v-9bd3170f>所有状态</option><option value="pending" data-v-9bd3170f>pending</option><option value="running" data-v-9bd3170f>running</option><option value="success" data-v-9bd3170f>success</option><option value="failed" data-v-9bd3170f>failed</option><option value="cancelled" data-v-9bd3170f>cancelled</option>', 6)
          ])], 512), [
            [R, o.value]
          ]),
          g(t("input", {
            "onUpdate:modelValue": l[1] || (l[1] = (u) => s.value = u),
            placeholder: "instance_id"
          }, null, 512), [
            [x, s.value]
          ]),
          g(t("input", {
            "onUpdate:modelValue": l[2] || (l[2] = (u) => i.value = u),
            placeholder: "node_id"
          }, null, 512), [
            [x, i.value]
          ])
        ])
      ]),
      t("div", Be, [
        t("span", null, "总数: " + f(n.runs.length), 1),
        t("span", null, "过滤: " + f(c.value.length), 1),
        t("span", je, "success: " + f(d("success")), 1),
        t("span", ze, "failed: " + f(d("failed")), 1),
        t("span", Le, "running: " + f(d("running")), 1)
      ]),
      t("table", null, [
        l[6] || (l[6] = t("thead", null, [
          t("tr", null, [
            t("th", null, "状态"),
            t("th", null, "instance"),
            t("th", null, "node"),
            t("th", null, "skill"),
            t("th", null, "触发人"),
            t("th", null, "时刻"),
            t("th", null, "耗时"),
            t("th", null, "操作")
          ])
        ], -1)),
        t("tbody", null, [
          (p(!0), m(k, null, w(c.value, (u) => (p(), m("tr", {
            key: u.run_id,
            class: C(u.status)
          }, [
            t("td", null, [
              t("span", {
                class: C(["status-badge", u.status])
              }, f(u.status), 3)
            ]),
            t("td", null, f(u.instance_id), 1),
            t("td", null, f(u.node_id), 1),
            t("td", null, f(u.skill_id), 1),
            t("td", null, f(u.triggered_by), 1),
            t("td", null, f(a(u.triggered_at)), 1),
            t("td", null, f(u.duration_sec ? u.duration_sec.toFixed(2) + "s" : "-"), 1),
            t("td", null, [
              t("button", {
                type: "button",
                onClick: (_) => r.$emit("view-detail", u)
              }, "详情", 8, Je),
              u.status === "running" ? (p(), m("button", {
                key: 0,
                type: "button",
                onClick: (_) => r.$emit("cancel", u.run_id)
              }, "取消", 8, We)) : b("", !0)
            ])
          ], 2))), 128)),
          c.value.length === 0 ? (p(), m("tr", Qe, [...l[5] || (l[5] = [
            t("td", {
              colspan: "8",
              class: "empty"
            }, "无匹配记录", -1)
          ])])) : b("", !0)
        ])
      ])
    ]));
  }
}), dt = /* @__PURE__ */ S(Ye, [["__scopeId", "data-v-9bd3170f"]]), Ge = { class: "ae-manual-node-form" }, He = { class: "name" }, Ke = { class: "type" }, Xe = {
  key: 0,
  class: "desc"
}, Ze = ["value", "onInput"], et = ["value", "onInput"], tt = ["checked", "onChange"], nt = ["value", "onInput"], ot = { class: "actions" }, it = /* @__PURE__ */ $({
  __name: "ManualNodeForm",
  props: {
    node: {}
  },
  emits: ["submit", "cancel"],
  setup(n, { emit: e }) {
    const o = n, s = e, i = I(
      Object.fromEntries((o.node.outputs ?? []).map((l) => [l.name, c(l.type)]))
    );
    function c(l) {
      return l === "int" || l === "float" ? 0 : l === "bool" ? !1 : l === "list" ? [] : l === "json_object" ? {} : "";
    }
    function d(l) {
      return l === "string" || l === "file_path";
    }
    function a(l) {
      return l === "int" || l === "float";
    }
    function r() {
      s("submit", i.value);
    }
    return (l, u) => (p(), m("div", Ge, [
      t("h3", null, f(n.node.name) + " (manual)", 1),
      u[2] || (u[2] = t("p", { class: "hint" }, "本节点 kind=manual, 由人工填表 → 写 nodeRuns", -1)),
      t("form", {
        onSubmit: z(r, ["prevent"])
      }, [
        (p(!0), m(k, null, w(n.node.outputs ?? [], (_) => (p(), m("div", {
          key: _.name,
          class: "field"
        }, [
          t("label", null, [
            t("span", He, f(_.name), 1),
            t("span", Ke, ": " + f(_.type), 1),
            _.description ? (p(), m("span", Xe, "— " + f(_.description), 1)) : b("", !0)
          ]),
          d(_.type) ? (p(), m("input", {
            key: 0,
            value: i.value[_.name],
            type: "text",
            onInput: (h) => i.value[_.name] = h.target.value
          }, null, 40, Ze)) : a(_.type) ? (p(), m("input", {
            key: 1,
            value: i.value[_.name],
            type: "number",
            onInput: (h) => i.value[_.name] = Number(h.target.value)
          }, null, 40, et)) : _.type === "bool" ? (p(), m("input", {
            key: 2,
            checked: i.value[_.name],
            type: "checkbox",
            onChange: (h) => i.value[_.name] = h.target.checked
          }, null, 40, tt)) : (p(), m("textarea", {
            key: 3,
            value: i.value[_.name],
            rows: "3",
            placeholder: "JSON or string",
            onInput: (h) => i.value[_.name] = h.target.value
          }, null, 40, nt))
        ]))), 128)),
        t("div", ot, [
          u[1] || (u[1] = t("button", { type: "submit" }, "提交", -1)),
          t("button", {
            type: "button",
            onClick: u[0] || (u[0] = (_) => l.$emit("cancel"))
          }, "取消")
        ])
      ], 32)
    ]));
  }
}), ct = /* @__PURE__ */ S(it, [["__scopeId", "data-v-a7c84de5"]]);
export {
  A as AdapterNotFoundError,
  dt as AuditView,
  W as CircularDependencyError,
  at as Engine,
  ut as ExecutionPlan,
  ct as ManualNodeForm,
  J as MissingRequiredInputError,
  Y as NodeAlreadyRunningError,
  lt as NodeEditor,
  K as PlanExpiredError,
  T as QueryNotWhitelistedError,
  L as RequiresExplicitTriggerError,
  ne as SkillPicker,
  q as TypePicker,
  G as UnknownRuntimeError,
  H as UnknownSkillError,
  Q as UpstreamFailedError,
  ce as UpstreamNodePicker
};
