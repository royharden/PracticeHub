import { CloudSwapError, type Profile } from './contracts.js';

const secretShape = /(sk-|AKIA|BEGIN PRIVATE KEY|password=)/i;

export function lintSecrets(profile: Profile): void {
  for (const [key, value] of Object.entries(profile.inlineSecrets)) {
    if (value.trim() !== '' || secretShape.test(key)) {
      throw new CloudSwapError('INLINE_SECRET', key);
    }
  }
  for (const [key, value] of Object.entries(profile.secretRefs)) {
    if (!value.startsWith('secret://')) {
      throw new CloudSwapError('SECRET_NOT_EXTERNALIZED', key);
    }
  }
}
