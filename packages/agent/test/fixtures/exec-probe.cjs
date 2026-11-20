const cp = require('node:child_process');
const moduleApi = require('node:module');

cp.execSync = function execSync(...args) {
  process.stderr.write(`PYTHON_PROBE:${args[0]}\n`);
  throw new Error('blocked probe');
};

moduleApi.syncBuiltinESMExports();
