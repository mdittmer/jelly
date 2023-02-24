'use strict';

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const cwd = join(__dirname, 'aws-bookstore-demo-app');
process.stdout.write(`\n\n========= running npm install in ${cwd} =========\n\n`);
const { stdout, stderr, status } = spawnSync('npm', ['install'], { cwd });
process.stdout.write(stdout);
process.stderr.write(stderr);
if (status !== 0) {
  throw new Error(`npm install failed in "${cwd}"; status ${status}`);
}
