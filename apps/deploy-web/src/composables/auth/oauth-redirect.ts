const REDIRECT_KEY = 'deploy-login-redirect';

export function saveLoginRedirect(path: string) {
  sessionStorage.setItem(REDIRECT_KEY, path);
}

export function consumeLoginRedirect(): string | null {
  const path = sessionStorage.getItem(REDIRECT_KEY);
  sessionStorage.removeItem(REDIRECT_KEY);
  return path;
}
