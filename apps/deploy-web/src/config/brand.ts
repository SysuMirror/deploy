export const BRAND = {
  name: 'SSE 部署台',
  /** 正式 logo（public/logo.png）；空则退回字母占位。用 BASE_URL 以兼容 /sdpy 前缀部署 */
  logo: `${import.meta.env.BASE_URL}logo.png`,
  accent: '#0284C7',
  tagline: '软工集市 · 模块内分别部署测试 / 正式环境',
};
