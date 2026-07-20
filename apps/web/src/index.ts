export const webBuildTargets = ['staff', 'member'] as const;
export type WebBuildTarget = (typeof webBuildTargets)[number];
