import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const runtimePath = fileURLToPath(new URL('./hython-subprocess.js', import.meta.url));
const vendorRuntimePath = path.resolve(path.dirname(runtimePath), '../../deploy/vendor/pcg/execution-runtimes/hython-subprocess.js');

test('H21 runtime requires explicit Utils bridge, package and resolver paths', () => {
  const source = fs.readFileSync(runtimePath, 'utf8');
  const vendorSource = fs.readFileSync(vendorRuntimePath, 'utf8');

  assert.equal(source, vendorSource, 'source and deploy/vendor runtimes must remain identical');
  assert.match(source, /bridgeScript/);
  assert.match(source, /h21PackagePath/);
  assert.match(source, /resolverPythonPath/);
  assert.match(source, /houdini_bridge\.h21\.pcg_subprocess\.package_cli/);
  assert.match(source, /pcg_subprocess[\\/]bridge\.py/);
  assert.doesNotMatch(source, /HYTHON_EXE/);
  assert.doesNotMatch(source, /Houdini 20|Houdini20/);
});
