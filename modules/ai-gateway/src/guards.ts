import { createHash } from 'node:crypto';

import type { EgressRequest } from '@practicehub/platform-integration';

import type { EgressPolicyPort, StoredBody, ToolAuthorizationPort } from './ports.js';
import type {
  AiGatewayRequest,
  GatewayBlockReason,
  IsolatedContentBlock,
  ToolAuthorizationDecision,
} from './types.js';

const refPattern = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const auditIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const capabilityDimensionValuePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export class GatewayRefusal extends Error {
  public constructor(
    public readonly reason: GatewayBlockReason,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayRefusal';
  }
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertRef(value: string, label: string): void {
  if (!refPattern.test(value)) {
    throw new GatewayRefusal('invalid-request', `${label} must use the lower-case ref grammar`);
  }
}

export function validateGatewayRequest(request: AiGatewayRequest): void {
  if (
    request.synthetic !== true ||
    request.binding.synthetic !== true ||
    request.grant.synthetic !== true
  ) {
    throw new GatewayRefusal(
      'invalid-request',
      'gateway request and policy snapshots must be synthetic',
    );
  }
  if (request.binding.enabled !== true || request.grant.enabled !== true) {
    throw new GatewayRefusal('policy-snapshot-mismatch', 'binding and grant must be enabled');
  }
  if (request.mode !== 'dev' || request.binding.mode !== 'dev') {
    throw new GatewayRefusal('prod-mode-disabled', 'this build accepts dev provider mode only');
  }
  for (const [label, value] of [
    ['tenantId', request.tenantId],
    ['subjectRef', request.subjectRef],
    ['useCase', request.useCase],
    ['cohortRef', request.cohortRef],
    ['actorRef', request.actorRef],
    ['purpose', request.purpose],
    ['interactionRef', request.interactionRef],
    ['idempotencyKey', request.idempotencyKey],
    ['bindingRef', request.binding.bindingRef],
    ['vendorId', request.binding.vendorId],
    ['modelRef', request.binding.modelRef],
    ['pinnedModelVersion', request.binding.pinnedModelVersion],
    ['promptTemplateVersion', request.binding.promptTemplateVersion],
    ['systemPolicyRef', request.binding.systemPolicyRef],
    ['aiSystemRef', request.grant.aiSystemRef],
  ] as const) {
    assertRef(value, label);
  }
  for (const [label, value] of [
    ['interactionAuditId', request.interactionAuditId],
    ['egressAuditId', request.egressAuditId],
  ] as const) {
    if (!auditIdPattern.test(value)) {
      throw new GatewayRefusal('invalid-request', `${label} must use the audit-id grammar`);
    }
  }
  for (const [label, value] of [
    ['interactionEventId', request.interactionEventId],
    ['egressEventId', request.egressEventId],
  ] as const) {
    if (!ulidPattern.test(value)) {
      throw new GatewayRefusal('invalid-request', `${label} must be an uppercase ULID`);
    }
  }
  for (const ref of request.content) {
    for (const [label, value] of [
      ['content tenantId', ref.tenantId],
      ['content subjectRef', ref.subjectRef],
      ['content bodyRef', ref.bodyRef],
      ['content originRef', ref.originRef],
    ] as const) {
      assertRef(value, label);
    }
    if (!sha256Pattern.test(ref.bodyHash)) {
      throw new GatewayRefusal('invalid-request', 'content bodyHash must be lower-case SHA-256');
    }
  }
  for (const value of request.allowedOriginRefs) assertRef(value, 'allowed origin');
  for (const value of request.knownSubjectRefs) assertRef(value, 'known subject');
  if (
    request.interactionEventId === request.egressEventId ||
    request.interactionAuditId === request.egressAuditId
  ) {
    throw new GatewayRefusal('invalid-request', 'interaction and egress evidence ids must differ');
  }
  if (
    !Number.isInteger(request.binding.version) ||
    request.binding.version < 1 ||
    !Number.isInteger(request.grant.version) ||
    request.grant.version < 1
  ) {
    throw new GatewayRefusal(
      'invalid-request',
      'policy snapshot versions must be positive integers',
    );
  }
  if (!isoInstantPattern.test(request.occurredAt) || !datePattern.test(request.asOf)) {
    throw new GatewayRefusal('invalid-request', 'gateway time fields must be pinned ISO values');
  }
  if (
    Number.isNaN(Date.parse(request.occurredAt)) ||
    new Date(request.occurredAt).toISOString().replace('.000Z', 'Z') !== request.occurredAt ||
    Number.isNaN(Date.parse(`${request.asOf}T00:00:00Z`)) ||
    new Date(`${request.asOf}T00:00:00Z`).toISOString().slice(0, 10) !== request.asOf ||
    request.occurredAt.slice(0, 10) !== request.asOf
  ) {
    throw new GatewayRefusal(
      'invalid-request',
      'gateway times must be real calendar values and asOf must equal the execution day',
    );
  }
  if (
    !capabilityDimensionValuePattern.test(request.useCase) ||
    !capabilityDimensionValuePattern.test(request.cohortRef)
  ) {
    throw new GatewayRefusal(
      'invalid-request',
      'useCase and cohortRef must be valid capability dimension values',
    );
  }
  if (
    request.binding.tenantId !== request.tenantId ||
    request.grant.tenantId !== request.tenantId
  ) {
    throw new GatewayRefusal('invalid-request', 'binding and grant must match the request tenant');
  }
  if (
    request.binding.useCase !== request.useCase ||
    request.binding.cohortRef !== request.cohortRef
  ) {
    throw new GatewayRefusal(
      'invalid-request',
      'binding must match the request use-case and cohort',
    );
  }
  if (
    request.grant.actorRef !== request.actorRef ||
    request.grant.subjectRef !== request.subjectRef ||
    request.grant.cohortRef !== request.cohortRef ||
    request.grant.purpose !== request.purpose
  ) {
    throw new GatewayRefusal(
      'invalid-request',
      'grant must match request actor, subject, cohort and purpose',
    );
  }
  if (request.content.length === 0) {
    throw new GatewayRefusal(
      'invalid-request',
      'gateway request must carry at least one content ref',
    );
  }
  const argumentKeyPattern = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
  const allowedTools = new Set(request.grant.allowedToolIds);
  if (allowedTools.size !== request.grant.allowedToolIds.length) {
    throw new GatewayRefusal('invalid-request', 'grant tool ids must be unique');
  }
  for (const toolId of allowedTools) assertRef(toolId, 'grant tool id');
  for (const [label, policies] of [
    ['allowed', request.grant.allowedArgumentKeysByTool],
    ['required', request.grant.requiredArgumentKeysByTool],
  ] as const) {
    for (const [toolId, keys] of Object.entries(policies)) {
      if (
        !allowedTools.has(toolId) ||
        !Array.isArray(keys) ||
        keys.some((key) => !argumentKeyPattern.test(key))
      ) {
        throw new GatewayRefusal(
          'invalid-request',
          `${label} argument policy must name an allowed tool and valid keys`,
        );
      }
    }
  }
  for (const toolId of allowedTools) {
    const allowed = request.grant.allowedArgumentKeysByTool[toolId] ?? [];
    const required = request.grant.requiredArgumentKeysByTool[toolId] ?? [];
    if (required.some((key) => !allowed.includes(key))) {
      throw new GatewayRefusal('invalid-request', 'required tool arguments must also be allowed');
    }
  }
}

const injectionPatterns = [
  /ignore\s+(all\s+)?(previous|prior|system)\s+instructions?/iu,
  /reveal\s+(the\s+)?(system|developer)\s+prompt/iu,
  /override\s+(the\s+)?(policy|authorization|tool grant)/iu,
  /call\s+(an?\s+)?(unlisted|admin|mutating)\s+tool/iu,
  /retrieve\s+(another|other)\s+patient/iu,
  /exfiltrat(e|ion)|send\s+secrets?\s+to/iu,
] as const;

const genericSecretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bsk-[A-Za-z0-9_-]{12,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*\b/u,
] as const;

function containsSecret(body: string, canaries: readonly string[]): boolean {
  return (
    genericSecretPatterns.some((pattern) => pattern.test(body)) ||
    canaries.some((canary) => canary.length > 0 && body.includes(canary))
  );
}

export function isolateContent(
  request: AiGatewayRequest,
  objects: readonly StoredBody[],
): readonly IsolatedContentBlock[] {
  return objects.map((object, index) => {
    const declared = request.content[index];
    if (declared === undefined) {
      throw new GatewayRefusal('invalid-request', 'object store returned an undeclared body');
    }
    if (
      object.tenantId !== request.tenantId ||
      object.subjectRef !== request.subjectRef ||
      declared.tenantId !== request.tenantId ||
      declared.subjectRef !== request.subjectRef
    ) {
      throw new GatewayRefusal('object-scope-mismatch', 'content object is outside request scope');
    }
    if (
      object.bodyRef !== declared.bodyRef ||
      object.bodyHash !== declared.bodyHash ||
      sha256(object.body) !== declared.bodyHash
    ) {
      throw new GatewayRefusal(
        'object-hash-mismatch',
        'content object does not match its declared hash',
      );
    }
    if (object.trust !== 'untrusted-data' || object.synthetic !== true) {
      throw new GatewayRefusal(
        'invalid-request',
        'content object must be synthetic untrusted data',
      );
    }
    if (!request.allowedOriginRefs.includes(object.originRef)) {
      throw new GatewayRefusal('origin-not-allowed', 'content origin is not allowlisted');
    }
    if (containsSecret(object.body, request.secretCanaries)) {
      throw new GatewayRefusal('input-secret', 'input secret detected before provider invocation');
    }
    if (injectionPatterns.some((pattern) => pattern.test(object.body.normalize('NFKC')))) {
      throw new GatewayRefusal(
        'prompt-injection',
        'untrusted content contains a control-plane instruction',
      );
    }
    return {
      originRef: object.originRef,
      bodyRef: object.bodyRef,
      bodyHash: object.bodyHash,
      body: object.body,
      trust: 'untrusted-data',
    };
  });
}

export function assertOutputSafe(request: AiGatewayRequest, body: string): void {
  if (containsSecret(body, request.secretCanaries)) {
    throw new GatewayRefusal('output-secret', 'provider output contains a secret canary');
  }
  const otherSubjects = request.knownSubjectRefs.filter((ref) => ref !== request.subjectRef);
  if (otherSubjects.some((ref) => ref.length > 0 && body.includes(ref))) {
    throw new GatewayRefusal('output-cross-subject', 'provider output names another subject');
  }
}

export class DefaultToolAuthorization implements ToolAuthorizationPort {
  public authorize(
    input: Parameters<ToolAuthorizationPort['authorize']>[0],
  ): ToolAuthorizationDecision {
    const { request, proposal, grant } = input;
    const scopeMatches =
      grant.tenantId === request.tenantId &&
      grant.actorRef === request.actorRef &&
      grant.subjectRef === request.subjectRef &&
      grant.cohortRef === request.cohortRef &&
      grant.purpose === request.purpose &&
      grant.environment === 'dev';
    const toolAllowed = grant.allowedToolIds.includes(proposal.toolId);
    const argumentKeys = Object.keys(proposal.arguments);
    const allowedArgumentKeys = grant.allowedArgumentKeysByTool[proposal.toolId] ?? [];
    const requiredArgumentKeys = grant.requiredArgumentKeysByTool[proposal.toolId] ?? [];
    const argumentsAllowed =
      argumentKeys.every((key) => allowedArgumentKeys.includes(key)) &&
      requiredArgumentKeys.every((key) => argumentKeys.includes(key)) &&
      (proposal.arguments['tenantId'] === undefined ||
        proposal.arguments['tenantId'] === request.tenantId) &&
      (proposal.arguments['actorRef'] === undefined ||
        proposal.arguments['actorRef'] === request.actorRef) &&
      (proposal.arguments['subjectRef'] === undefined ||
        proposal.arguments['subjectRef'] === request.subjectRef) &&
      (proposal.arguments['cohortRef'] === undefined ||
        proposal.arguments['cohortRef'] === request.cohortRef) &&
      (proposal.arguments['purpose'] === undefined ||
        proposal.arguments['purpose'] === request.purpose) &&
      !request.knownSubjectRefs.some(
        (subjectRef) =>
          subjectRef !== request.subjectRef &&
          Object.values(proposal.arguments).includes(subjectRef),
      );
    const sideEffectAllowed =
      proposal.sideEffect === 'none' ||
      (proposal.sideEffect === 'draft' && grant.allowDraftSideEffect);
    const purposeMatches = proposal.requestedPurpose === request.purpose;
    const allow =
      scopeMatches && toolAllowed && argumentsAllowed && sideEffectAllowed && purposeMatches;
    return {
      allow,
      reason: allow ? 'authorized-inert-proposal' : 'denied-outside-model',
      grantVersion: grant.version,
      proposal,
    };
  }
}

export function gatewayEgressRequest(request: AiGatewayRequest): EgressRequest {
  return {
    tenantId: request.tenantId,
    vendorId: request.binding.vendorId,
    phiClass: request.dataClassification,
    categories: request.phiCategories,
    purpose: request.purpose,
    asOf: request.asOf,
    actorRef: request.actorRef,
    occurredAt: request.occurredAt,
  };
}

export function requireEgressAllowed(port: EgressPolicyPort, request: AiGatewayRequest): void {
  const decision = port.evaluate(gatewayEgressRequest(request));
  if (!decision.allow) {
    throw new GatewayRefusal(
      'provider-egress-denied',
      `provider egress denied (${decision.reason})`,
    );
  }
}
