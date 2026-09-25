/**
 * Named stand-in for the CRM member aggregate. WP-070 is not built.
 * Replace this type and fixtures/WP-070.member.json when WP-070 lands.
 */
export interface Wp070CrmMember {
  readonly placeholderFor: 'WP-070';
  readonly memberId: string;
  readonly tenantId: string;
  readonly synthetic: true;
}
