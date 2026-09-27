# -*- coding: utf-8 -*-
"""mock skill: echo input message (runtime=python_daemon)

由 v8_framework skill_runner 加载, 验段 3 daemon 双轨 → skill_runner 路径.
不依赖 unreal (但跑在 UE Python daemon 环境内, 可以 import unreal).
"""


def run(inputs, ctx):
    message = inputs.get("message", "<empty>")
    return {
        "outputs_summary": {
            "echoed": "[python_daemon] " + str(message),
            "ctx_run_id": ctx.get("run_id", ""),
        }
    }
