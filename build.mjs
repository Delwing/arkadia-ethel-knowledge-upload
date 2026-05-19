import { build, context } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const OUTDIR = 'dist';
const PORT = 5174;

mkdirSync(OUTDIR, { recursive: true });

const buildOptions = {
  entryPoints: ['plugin.ts'],
  bundle: true,
  format: 'esm',
  outfile: resolve(OUTDIR, 'plugin.js'),
  sourcemap: true,
  target: 'es2022',
  logLevel: 'info',
};

const copyCallback = () => {
  copyFileSync('oauth-callback.html', resolve(OUTDIR, 'oauth-callback.html'));
};

if (process.argv.includes('--serve')) {
  const ctx = await context({
    ...buildOptions,
    plugins: [
      {
        name: 'copy-callback',
        setup(build) {
          build.onEnd(() => copyCallback());
        },
      },
    ],
  });
  await ctx.watch();
  const server = await ctx.serve({ port: PORT, servedir: OUTDIR });
  console.log(`Plugin served at http://${server.host}:${server.port}/plugin.js`);
  console.log(`Callback at http://${server.host}:${server.port}/oauth-callback.html`);
} else {
  await build(buildOptions);
  copyCallback();
  console.log(`Built ${OUTDIR}/plugin.js + ${OUTDIR}/oauth-callback.html`);
}
