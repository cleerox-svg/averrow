// Security page barrel. The orchestrator re-exports this from ../index.ts:
//   export * from './security';
export { SecuritySettings } from '../SecuritySettings';
export { createStrictPasskeyAdapter, type StrictPasskeyAdapterOptions } from './passkeyAdapter';
export { parseUserAgent, type ParsedUserAgent, type DeviceClass } from './userAgent';
export { normalizeSessions, type NormalizedSessions } from './sessions';
export {
  DEFAULT_SECURITY_ENDPOINTS,
  type SecuritySettingsProps, type SecurityApiClient, type SecurityApiResponse,
  type SecurityPasskeyAdapter, type SecurityEndpoints, type SecuritySession,
} from './types';
