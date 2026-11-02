import { run } from '../src/system';
import { mkdir } from 'node:fs/promises';

const compiler = process.execPath;
const capability = await run([compiler, 'compile', '--help']);
if (capability.code !== 0 || !capability.stdout.includes('--no-aot')) {
  console.error('The installed Bun does not support native AOT. Install an AOT-enabled Bun version, then run bun run build again.');
  process.exit(1);
}
await mkdir('dist', { recursive: true });
const child = Bun.spawn([compiler, 'compile', '--no-script', '--trim', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', 'src/cli.ts', '--outfile', 'dist/sbm'], {
  stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
});
process.exitCode = await child.exited;
