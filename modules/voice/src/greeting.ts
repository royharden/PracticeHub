export const AFTER_HOURS_911_DIRECTIVE =
  'If this is a medical emergency, hang up and dial 911 now. For an urgent callback, stay on the line or leave a message after the tone.';

export function afterHoursUnansweredGreeting(): {
  readonly text: string;
  readonly includes911: true;
} {
  return { text: AFTER_HOURS_911_DIRECTIVE, includes911: true };
}
