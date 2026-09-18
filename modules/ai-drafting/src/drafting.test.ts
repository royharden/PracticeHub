import { describe, expect, it } from 'vitest';

import {
  autoSend,
  decideQueue,
  draftArtifact,
  renderProvenance,
  restoreQuarantine,
} from './drafting.js';
import { binding, ports } from './test-support.js';
import { DraftingRefusal } from './types.js';

describe('WP-102 drafting surfaces', () => {
  it('never auto-sends a drafted message', () => {
    const harness = ports();
    const draft = draftArtifact(harness, {
      draftId: 'draft:1',
      kind: 'message',
      binding: binding(),
      body: 'synthetic reply',
      sourceRefs: ['thread:sg-p-0008:inbox'],
    });
    expect(() => autoSend(draft)).toThrow(DraftingRefusal);
    expect(harness.thread.outbound).toEqual([]);
  });

  it('queues a draft and sends only after human approve when eval is green', () => {
    const harness = ports();
    const draft = draftArtifact(harness, {
      draftId: 'draft:2',
      kind: 'message',
      binding: binding(),
      body: 'synthetic reply',
      sourceRefs: ['note:1'],
    });
    expect(draft.state).toBe('queued');
    const rendered = renderProvenance(draft.provenance);
    expect(rendered).toContain('written by the named reviewer with support of automated tools');
    const sent = decideQueue(harness, draft, 'approve', 'guide:1');
    expect(sent.state).toBe('sent');
    expect(harness.thread.outbound).toHaveLength(1);
    expect(sent.provenance.reviewerAction).toBe('approve');
  });

  it('blocks send when a required eval metric is red', () => {
    const harness = ports();
    const draft = draftArtifact(harness, {
      draftId: 'draft:3',
      kind: 'summary',
      binding: binding({ useCase: 'previsit-brief' }),
      body: 'synthetic brief',
      sourceRefs: ['lab:1'],
      requiredMetricRed: true,
    });
    expect(draft.evalDecision).toBe('promotion-blocked');
    expect(() => decideQueue(harness, draft, 'approve', 'guide:1')).toThrow(
      /red required eval metric blocks send/,
    );
    expect(harness.thread.outbound).toEqual([]);
  });

  it('quarantines a wrong-patient draft and restores only the bound subject', () => {
    const harness = ports({ subjectRef: 'sg-p-0099' });
    const draft = draftArtifact(harness, {
      draftId: 'draft:4',
      kind: 'message',
      binding: binding(),
      body: 'synthetic reply',
      sourceRefs: ['thread:sg-p-0008:inbox'],
    });
    expect(draft.state).toBe('quarantined');
    expect(draft.quarantineReason).toBe('wrong-patient-subject');
    expect(() => decideQueue(harness, draft, 'approve', 'guide:1')).toThrow(
      /quarantined drafts cannot leave/,
    );
    const restored = restoreQuarantine(draft, binding().subjectRef);
    expect(restored.state).toBe('queued');
    expect(() => restoreQuarantine(draft, 'sg-p-0099')).toThrow(/must match the draft binding/);
  });

  it('an edit decision re-queues without sending', () => {
    const harness = ports();
    const draft = draftArtifact(harness, {
      draftId: 'draft:edit',
      kind: 'message',
      binding: binding(),
      body: 'synthetic reply',
      sourceRefs: ['src:1'],
    });
    const edited = decideQueue(harness, draft, 'edit', 'guide:1', 'edited synthetic reply');
    expect(edited.state).toBe('queued');
    expect(edited.body).toBe('edited synthetic reply');
    expect(edited.provenance.reviewerAction).toBe('edit');
    expect(harness.thread.outbound).toEqual([]);
  });

  it('a reject decision does not enqueue outbound', () => {
    const harness = ports();
    const draft = draftArtifact(harness, {
      draftId: 'draft:reject',
      kind: 'message',
      binding: binding(),
      body: 'synthetic reply',
      sourceRefs: ['src:1'],
    });
    expect(decideQueue(harness, draft, 'reject', 'guide:1').state).toBe('rejected');
    expect(harness.thread.outbound).toEqual([]);
  });

  it('refuses drafting when the feature flag is off', () => {
    const harness = ports({ draftingSurfacesEnabled: false });
    expect(() =>
      draftArtifact(harness, {
        draftId: 'draft:5',
        kind: 'message',
        binding: binding(),
        body: 'synthetic reply',
        sourceRefs: ['thread:1'],
      }),
    ).toThrow(/flagged off/);
  });
});
