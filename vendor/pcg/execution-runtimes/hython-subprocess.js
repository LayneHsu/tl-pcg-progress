// hython-subprocess: PCG 业务侧 engine ExecutionRuntime 实现 (hython_subprocess)
//
// Node 端先以显式 H21 package 解析 hython，再启动 Utils 的 bridge.py。
// JSON IPC: inputs.json (Node 写) → bridge 跑 skill → outputs.json (bridge 写) → Node 读
//
// 调用方必须提供 Utils 内 h21/pcg_subprocess/bridge.py、H21 package 和 Python resolver。
//
// 注册到 engine: engine.registerExecutionRuntime('hython_subprocess', createHythonSubprocessRuntime(opts))
// 跟 engine ExecutionRuntime interface 对齐: { run_skill: async (skillId, inputs, ctx) => result }
//
// 跟 PCG 段 3 plan §Task 3.2 对齐.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 60000;

function requirePath(value, name) {
  if (!value || typeof value !== 'string' || !value.trim()) {
    throw new Error(`createHythonSubprocessRuntime 需 ${name} 绝对路径`);
  }
  return path.resolve(value);
}

function resolveUtilsPythonRoot(bridgeScript) {
  const bridgePath = requirePath(bridgeScript, 'bridgeScript');
  const pcgSubprocessRoot = path.dirname(bridgePath);
  const h21Root = path.dirname(pcgSubprocessRoot);
  const bridgeRoot = path.dirname(h21Root);
  const pythonRoot = path.dirname(bridgeRoot);
  const expectedBridgePath = path.join(
    pythonRoot,
    'houdini_bridge',
    'h21',
    'pcg_subprocess',
    'bridge.py',
  );
  if (path.normalize(bridgePath) !== path.normalize(expectedBridgePath)) {
    throw new Error('bridgeScript 必须指向 Utils/houdini_bridge/h21/pcg_subprocess/bridge.py');
  }
  return { bridgePath, pythonRoot };
}

function resolveHythonPath({ resolverPythonPath, h21PackagePath, utilsPythonRoot }) {
  const resolverPath = requirePath(resolverPythonPath, 'resolverPythonPath');
  const packagePath = requirePath(h21PackagePath, 'h21PackagePath');
  const existingPythonPath = process.env.PYTHONPATH;
  const resolver = spawnSync(
    resolverPath,
    [
      '-m',
      'houdini_bridge.h21.pcg_subprocess.package_cli',
      '--package', packagePath,
      '--tool', 'hython',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PYTHONPATH: existingPythonPath
          ? `${utilsPythonRoot}${path.delimiter}${existingPythonPath}`
          : utilsPythonRoot,
      },
    },
  );
  if (resolver.error) {
    throw new Error(`H21 package resolver 无法启动: ${resolver.error.message}`);
  }
  if (resolver.status !== 0) {
    throw new Error(`H21 package resolver 失败: ${(resolver.stderr || '').trim()}`);
  }

  let response;
  try {
    response = JSON.parse((resolver.stdout || '').trim());
  } catch (error) {
    throw new Error(`H21 package resolver 返回无效 JSON: ${error.message}`);
  }
  if (
    !response ||
    response.tool !== 'hython' ||
    typeof response.path !== 'string' ||
    !response.path ||
    typeof response.version !== 'string' ||
    !/^21(?:\.|$)/.test(response.version)
  ) {
    throw new Error('H21 package resolver 返回不符合契约的 hython 路径');
  }
  return response.path;
}

/**
 * 工厂: 建 PCG hython_subprocess execution runtime.
 *
 * @param {object} opts
 * @param {string} opts.bridgeScript — Utils/houdini_bridge/h21/pcg_subprocess/bridge.py 绝对路径
 * @param {string} opts.h21PackagePath — 显式 H21 package JSON 绝对路径
 * @param {string} opts.resolverPythonPath — 可运行 Utils package CLI 的 Python 绝对路径
 * @param {string} [opts.skillsRoot] — PCG skills 根目录，默认当前工作目录的 skills/
 * @param {number} [opts.timeoutMs=60000] — 子进程超时. SIGKILL 防 Houdini 残留
 * @returns {{run_skill: (skillId: string, inputs: object, ctx: object) => Promise<object>}}
 */
export function createHythonSubprocessRuntime({
  bridgeScript,
  h21PackagePath,
  resolverPythonPath,
  skillsRoot = path.resolve(process.cwd(), 'skills'),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const { bridgePath, pythonRoot } = resolveUtilsPythonRoot(bridgeScript);
  const packagePath = requirePath(h21PackagePath, 'h21PackagePath');
  const resolverPath = requirePath(resolverPythonPath, 'resolverPythonPath');
  const resolvedSkillsRoot = requirePath(skillsRoot, 'skillsRoot');
  let hythonPath = null;

  return {
    run_skill: async (skillId, inputs, ctx) => {
      if (!hythonPath) {
        hythonPath = resolveHythonPath({
          resolverPythonPath: resolverPath,
          h21PackagePath: packagePath,
          utilsPythonRoot: pythonRoot,
        });
      }
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcg-hython-'));
      const inputsPath = path.join(tmpDir, 'inputs.json');
      const outputsPath = path.join(tmpDir, 'outputs.json');
      fs.writeFileSync(inputsPath, JSON.stringify({ skill_id: skillId, inputs, ctx }), 'utf-8');

      return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* noop */ }
        };

        const proc = spawn(hythonPath, [
          bridgePath,
          '--inputs', inputsPath,
          '--outputs', outputsPath,
          '--skills-root', resolvedSkillsRoot,
        ]);

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { proc.kill('SIGKILL'); } catch (e) { /* noop */ }
          cleanup();
          reject(new Error(`hython_subprocess ${skillId} timeout ${timeoutMs}ms (kill SIGKILL)`));
        }, timeoutMs);

        proc.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cleanup();
          reject(new Error(`hython_subprocess spawn fail (${hythonPath}): ${err.message}`));
        });

        proc.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);

          if (code !== 0) {
            cleanup();
            reject(new Error(`hython_subprocess ${skillId} exit code ${code} (非 0 = hython 进程异常, 非 skill 失败)`));
            return;
          }

          let out;
          try {
            out = JSON.parse(fs.readFileSync(outputsPath, 'utf-8'));
          } catch (e) {
            cleanup();
            reject(new Error(`hython_subprocess outputs.json parse fail: ${e.message}`));
            return;
          }
          cleanup();

          if (out.status === 'failed') {
            reject(new Error(`hython ${skillId} failed: ${out.error_message || '<no message>'}`));
            return;
          }
          // engine ExecutionRuntime contract: 返 Record
          resolve({
            outputs_summary: out.outputs_summary || {},
            outputs_local_path: out.outputs_local_path,
          });
        });
      });
    },
  };
}
