import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';

export const requiredParityContracts = Object.freeze([
  'wp030-accountable-message-page/v1',
  'wp031-paid-service-page/v1',
  'wp032-clinical-coexistence-page/v1',
  'portal-intake-accessibility/v1',
]);

// This source-owned registry is intentionally empty while real adapters are
// unavailable. JSON readiness labels cannot populate it. A future entry must
// execute its comparison and return immutable four-class evidence.
const executableAdapterRegistry = Object.freeze(new Map());

function validEvidence(contractId, evidence) {
  return (
    evidence !== null &&
    typeof evidence === 'object' &&
    evidence.contractId === contractId &&
    /^[a-f0-9]{64}$/.test(evidence.evidenceSha256 ?? '') &&
    Array.isArray(evidence.fixtureClasses) &&
    evidence.fixtureClasses.join(',') === 'HAPPY,BOUNDARY,FAILURE,RECOVERY' &&
    evidence.normalizedParity === 'passed'
  );
}

export async function evaluateParityAcceptance(
  bindings,
  adapterRegistry = executableAdapterRegistry,
) {
  const gates = Array.isArray(bindings.parityGates) ? bindings.parityGates : [];
  const blocked = [];
  const evidence = [];
  for (const contractId of requiredParityContracts) {
    const gate = gates.find((candidate) => candidate.contractId === contractId);
    const adapter = adapterRegistry.get(contractId);
    if (!gate || gate.status !== 'ready' || typeof adapter !== 'function') {
      blocked.push(contractId);
      continue;
    }
    const result = await adapter();
    if (!validEvidence(contractId, result)) {
      blocked.push(contractId);
      continue;
    }
    evidence.push(Object.freeze({ ...result }));
  }
  return Object.freeze({
    accepted: blocked.length === 0 && evidence.length === requiredParityContracts.length,
    blocked: Object.freeze(blocked),
    evidence: Object.freeze(evidence),
  });
}

async function main() {
  const bindings = JSON.parse(
    readFileSync(new URL('./journey-bindings.v1.json', import.meta.url), 'utf8'),
  );
  const result = await evaluateParityAcceptance(bindings);
  if (!result.accepted) {
    process.stderr.write(
      'WP-035 real-provider parity BLOCKED: ' + result.blocked.join(', ') + '\n',
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write('WP-035 real-provider normalized parity passed with immutable evidence.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
