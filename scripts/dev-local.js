import { spawn } from 'node:child_process';

const child = spawn('npm', ['--prefix', 'server', 'start'], {
  stdio: 'inherit',
  shell: true
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
