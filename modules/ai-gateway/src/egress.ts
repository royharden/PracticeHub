import {
  evaluateEgress,
  type EgressDecision,
  type EgressRequest,
} from '@practicehub/platform-integration';

import type { EgressPolicyPort, VendorRowResolver } from './ports.js';

/** Concrete WP-026 binding: no gateway-local allowlist or override exists. */
export class VendorRegistryEgressPolicy implements EgressPolicyPort {
  public constructor(private readonly resolveVendor: VendorRowResolver) {}

  public evaluate(request: EgressRequest): EgressDecision {
    return evaluateEgress(this.resolveVendor(request.tenantId, request.vendorId), request);
  }
}
