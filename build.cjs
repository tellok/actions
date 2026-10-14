'use strict';
const ncc = require('@vercel/ncc');
const { mkdir, writeFile } = require('node:fs/promises');
const { resolve } = require('node:path');
(async () => {
  for (const component of ['s3-artifacts', 'github-release']) {
    const directory = resolve('github-actions', component);
    const { code, assets } = await ncc(resolve(directory, 'lib/runtime.cjs'), { minify: true, target: 'es2020' });
    await mkdir(resolve(directory, 'dist'), { recursive: true });
    await writeFile(resolve(directory, 'dist/index.js'), code);
    for(const [name,asset] of Object.entries(assets)) {
      const target=resolve(directory,'dist',name);
      await mkdir(require('node:path').dirname(target),{recursive:true});
      await writeFile(target,asset.source,{mode:asset.permissions});
    }
    console.log(`Bundled ${component}`);
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
