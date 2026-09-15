/**
 * The Cognito/Amplify login flow (Google + email OTP + enterprise SSO) is
 * cloud-only and unreachable here — `lib/auth/login-content.tsx` only lazy-
 * loads this arm when `IS_CLOUD`, which is permanently false in this
 * onprem-only fork (the self-hosted `OnpremLoginContent` is what actually
 * renders). Null stand-in.
 */
export const LoginContent = () => null;
