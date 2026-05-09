// @averrow/shared/login — unified Login page for averrow-ops
// (and future siblings like FarmTrack) per SHARED_LOGIN_SPEC §1.
//
// Each app renders LoginPage with branding deltas and adapter
// callbacks:
//
//   <LoginPage
//     branding={{
//       brandLetters:   'AV',
//       productName:    'Averrow',
//       tagline:        'AI-FIRST THREAT INTELLIGENCE',
//       footerPillars:  'Detect · Analyze · Correlate · Respond',
//     }}
//     apiClient={...}
//     passkeyAdapter={...}
//     lastSignInMethod={makeLastSignInMethodAdapter('averrow.lastSignInMethod')}
//     returnTo="/v2/"
//   />

export { LoginPage } from './LoginPage';
export {
  makeLastSignInMethodAdapter, clearLastSignInMethod,
} from './lastSignInMethod';
export type {
  LoginPageProps, LoginBranding, LoginApiClient, LoginApiResponse,
  PasskeyLoginAdapter, LastSignInMethodAdapter, SignInMethod,
} from './types';
