import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const { outputFiles } = await build({
  entryPoints: [new URL('ui/progress-card.js', root).pathname],
  bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
});
const template = await readFile(new URL('ui/progress-card.template.html', root), 'utf8');
const script = outputFiles[0].text.replaceAll('</script', '<\\/script');
await writeFile(new URL('src/progress-card.html', root), template.replace('/*__APP_SCRIPT__*/', () => script));
console.log(`Built inline progress card (${Buffer.byteLength(script)} script bytes).`);
