// Check the deploy artifact, not just whether `next build` completed.
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root=resolve('.netlify/static');
const html=await readFile(resolve(root,'index.html'),'utf8');
assert.match(html,/Paste a song or playlist link/,'Netlify must publish the actual homepage at /index.html');
const assets=[...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"?]+)(?:[^"]*)"/g)].map(match=>match[1]);
assert(assets.length>0,'The homepage must include its hydration assets');
await Promise.all(assets.map(path=>access(resolve(root,`.${path}`))));
await access(resolve(root,'ffmpeg/ffmpeg-core.wasm'));
const manifest=JSON.parse(await readFile('.netlify/functions/manifest.json','utf8'));
assert(manifest.functions.some(fn=>fn.name==='___netlify-server-handler' && fn.routes?.some(route=>route.pattern==='/*' && route.prefer_static)),'The Next.js API handler must remain deployed behind static files');
console.log('Netlify homepage, hydration assets, audio engine, and API routing: OK');
