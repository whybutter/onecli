/**
 * SSO is permanently dropped in this build. `app/auth/login/sso/page.tsx`
 * redirects to the regular login unconditionally rather than rendering
 * this, so it is never reached — kept as a null stand-in for compilation
 * and for any future re-introduction of the route.
 */
export const SsoLoginContent = () => null;
