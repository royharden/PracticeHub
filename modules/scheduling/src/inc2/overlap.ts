import type { TimeInterval } from '../types.js';

export function isVirtualService(serviceId: string): boolean {
  return serviceId.startsWith('telehealth') || serviceId.startsWith('virtual');
}

export function travelBufferMinutes(
  left: { serviceId: string },
  right: { serviceId: string },
  inPersonBufferMinutes: number,
): number {
  if (isVirtualService(left.serviceId) || isVirtualService(right.serviceId)) {
    return 0;
  }
  return inPersonBufferMinutes;
}

export function intervalsOverlap(
  left: TimeInterval,
  right: TimeInterval,
  bufferMinutes: number,
): boolean {
  const bufferMs = bufferMinutes * 60_000;
  const leftStart = Date.parse(left.start) - bufferMs;
  const leftEnd = Date.parse(left.end) + bufferMs;
  const rightStart = Date.parse(right.start);
  const rightEnd = Date.parse(right.end);
  return leftStart < rightEnd && rightStart < leftEnd;
}
