# -*- coding: utf-8 -*-
"""mock skill: echo input message (runtime=hython_subprocess)

由 xdverse-pcg hython_bridge.py 调 (hython.exe 内 import + 跑 run).
不依赖 hou (但跑在 Houdini hython 环境内, 可以 import hou).
"""


def run(inputs, ctx):
    message = inputs.get("message", "<empty>")
    return {
        "outputs_summary": {
            "echoed": "[hython] " + str(message),
        }
    }
