import { defineConfig } from 'astro/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';

// Al compilar, escribe en dist/sw.js la lista real de archivos (incluye /_astro/*.js y *.css con hash)
// y una versión de caché que cambia con el contenido, para que la app instalada funcione sin internet.
const precache = () => ({
  name: 'precache-sw',
  hooks: {
    'astro:build:done': ({ dir }) => {
      const root = fileURLToPath(dir);
      const files = [];
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) walk(full);
          else files.push('/' + path.relative(root, full).split(path.sep).join('/'));
        }
      };
      walk(root);
      // /lab (y Tone.js, que solo usa esa página) no se guardan para uso sin internet
      const labOnly = (f) => f.startsWith('/lab/') || (f.endsWith('.js') && fs.readFileSync(path.join(root, f), 'utf8').includes('GrainPlayer'));
      const urls = files
        .filter((f) => f !== '/sw.js' && !f.endsWith('.map') && !labOnly(f))
        .map((f) => (f === '/index.html' ? '/' : f))
        .sort();
      const hash = crypto.createHash('sha256');
      for (const f of files) if (f !== '/sw.js') hash.update(f).update(fs.readFileSync(path.join(root, f)));
      const swPath = path.join(root, 'sw.js');
      const sw = fs.readFileSync(swPath, 'utf8')
        .replace("'__PRECACHE__'", JSON.stringify(urls))
        .replace('__VERSION__', hash.digest('hex').slice(0, 10));
      fs.writeFileSync(swPath, sw);
    },
  },
});

export default defineConfig({
  integrations: [precache()],
  vite: { plugins: [tailwindcss()] },
});
