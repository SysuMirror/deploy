import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getBaseDomain } from '../db/init.js';
import { listProjectsForUser } from '../services/project.js';
import { getPublicBasePath, isRootPublicBase } from '../config/paths.js';
import { isPlatformAdmin } from '../services/platform-admin.js';
import { isAgentFixerGloballyEnabled } from '../services/build-fixer.js';
import { checkDeveloper, devPlatformConfigured, DEV_PLATFORM_BASE_URL } from '../services/devplatform.js';

const router = Router();
const JOIN_URL = `${DEV_PLATFORM_BASE_URL}/join`;

// 进入平台的统一 bootstrap。鉴权已在 authMiddleware 完成（严格开发者制），
// 此处仅补充开发者身份信息供前端展示（含申请链接）。
router.get('/bootstrap', authMiddleware, async (req, res) => {
  const isAdmin = isPlatformAdmin(req.user!.id);
  const projects = listProjectsForUser(req.user!.id);

  let dev: {
    configured: boolean;
    checked: boolean;
    isDeveloper: boolean;
    isAdmin: boolean;
    name?: string;
    effective?: boolean;
    joinUrl: string;
    platformUrl: string;
  } = {
    configured: false,
    checked: false,
    isDeveloper: Boolean(req.user!.isDeveloper),
    isAdmin,
    joinUrl: JOIN_URL,
    platformUrl: DEV_PLATFORM_BASE_URL,
  };
  if (devPlatformConfigured()) {
    try {
      const c = await checkDeveloper(req.user!.oauthId || '');
      // 以「登录时固化的会话身份」兜底，实时返回作为展示 info。
      // 关键：即使平台临时异常/缓存不一致，也不能把真实开发者（含平台管理员）显示成非开发者。
      const sessionDev = Boolean(req.user!.isDeveloper) || isAdmin;
      dev = {
        configured: true,
        checked: true,
        isDeveloper: sessionDev,
        isAdmin: isAdmin || c.isAdmin,
        name: c.displayName || c.name || '',
        effective: sessionDev,
        joinUrl: JOIN_URL,
        platformUrl: DEV_PLATFORM_BASE_URL,
      };
    } catch (e) {
      // 平台不可达：以会话固化身份为准（登录时已确认），避免误伤真实开发者
      const sessionDev = Boolean(req.user!.isDeveloper) || isAdmin;
      dev = {
        configured: true,
        checked: false,
        isDeveloper: sessionDev,
        isAdmin,
        effective: sessionDev,
        joinUrl: JOIN_URL,
        platformUrl: DEV_PLATFORM_BASE_URL,
      };
    }
  }

  res.json({
    user: {
      ...req.user,
      isPlatformAdmin: isAdmin,
      isDeveloper: dev.isDeveloper,
    },
    projects,
    baseDomain: getBaseDomain(),
    publicBasePath: getPublicBasePath() || '/',
    rootMode: isRootPublicBase(),
    agentFixerEnabled: isAgentFixerGloballyEnabled(),
    gateRequired: false,
    dev,
  });
});

export default router;
