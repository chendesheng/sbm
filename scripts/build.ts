import { exists, run } from '../src/system';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

const compiler = await exists('.tools/bun') ? resolve('.tools/bun') : process.execPath;
const capability = await run([compiler, 'compile', '--help']);
if (capability.code !== 0 || !capability.stdout.includes('--no-aot')) {
  console.error('This Bun does not support native AOT. Run bun run setup:compiler first. No bundled-runtime fallback is produced.');
  process.exit(1);
}
await mkdir('dist', { recursive: true });
const child = Bun.spawn([compiler, 'compile', '--no-script', '--trim', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', 'src/cli.ts', '--outfile', 'dist/sbm'], {
  stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
});
process.exitCode = await child.exited;
