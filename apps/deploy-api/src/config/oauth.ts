import { loadEnvFile } from './load-env.js';

loadEnvFile();

function trimTrailingSlash(url: string) {
  return url.replace(/\/$/, '');
}

// UniSSO 机器对机器密码校验（平台自持邮箱+密码表单，后端持 client 凭据代验，无 OAuth 跳转）：
// POST {issuer}/api/oauth/password/verify，form: email/password/client_id/client_secret
export const oauthConfig = {
  issuer: trimTrailingSlash(process.env.UNISSO_ISSUER ?? 'https://sso.ssemarket.cn'),
  clientId: process.env.UNISSO_CLIENT_ID ?? '',
  clientSecret: process.env.UNISSO_CLIENT_SECRET ?? '',
};

export function isOAuthConfigured() {
  return Boolean(oauthConfig.issuer && oauthConfig.clientId && oauthConfig.clientSecret);
}
