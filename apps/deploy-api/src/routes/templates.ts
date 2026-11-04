import AdmZip from 'adm-zip';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

const TEMPLATES_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../deploy/examples/templates'
);

const CATALOG: Record<string, { dir: string; fileName: string; title: string }> = {
  'compose-module': {
    dir: 'compose-module',
    fileName: 'compose-module-template.zip',
    title: '压缩包部署模板（frontend + backend + compose.yml）',
  },
  'sseinfra-module': {
    dir: 'sseinfra-module',
    fileName: 'sseinfra-module-template.zip',
    title: 'Git/sseinfra 模板（仓根 deploy.sh）',
  },
};

router.get('/', authMiddleware, (_req, res) => {
  res.json({
    templates: Object.entries(CATALOG).map(([id, t]) => ({
      id,
      title: t.title,
      downloadPath: `/api/v1/templates/${id}.zip`,
    })),
  });
});

router.get('/:id.zip', authMiddleware, (req, res) => {
  const id = req.params.id;
  const meta = CATALOG[id];
  if (!meta) {
    res.status(404).json({ error: '模板不存在' });
    return;
  }
  const dir = join(TEMPLATES_ROOT, meta.dir);
  if (!existsSync(dir)) {
    res.status(500).json({ error: '模板目录缺失' });
    return;
  }
  const zip = new AdmZip();
  zip.addLocalFolder(dir, meta.dir);
  const buf = zip.toBuffer();
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${meta.fileName}"`);
  res.send(buf);
});

export default router;
