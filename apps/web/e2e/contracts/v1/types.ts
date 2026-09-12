import type { Page } from '@playwright/test';

export const fixtureClasses = ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY'] as const;
export type FixtureClass = (typeof fixtureClasses)[number];

export interface CorpusReference {
  readonly subjectId: string;
  readonly personaSlug: string;
  readonly journey: string;
}

export interface ContractFixture {
  readonly fixtureClass: FixtureClass;
  readonly reference: CorpusReference;
  readonly locale: string;
  readonly largePrint: boolean;
  readonly operationKey: string;
  readonly actionNote: string;
  readonly apiOutcome: 'success' | 'failure' | 'recoverable';
  readonly failureMode:
    | 'none'
    | 'validation'
    | 'authority'
    | 'consent'
    | 'translation'
    | 'accommodation'
    | 'dependency';
  readonly expectedEffectCount: number;
}

export interface FixturePack {
  readonly synthetic: true;
  readonly fixtureClass: FixtureClass;
  readonly simulatedClock: '2026-01-01T00:00:00Z';
  readonly contracts: Readonly<Record<ContractKey, Omit<ContractFixture, 'fixtureClass'>>>;
}

export type ContractKey = 'wp030' | 'wp031' | 'wp032';

export interface SemanticState {
  readonly contractId: string;
  readonly heading: string;
  readonly landmarks: readonly string[];
  readonly namedControls: readonly string[];
  readonly focusOwner: string | null;
  readonly status: string;
  readonly error: string;
  readonly effectCount: number;
}

export interface JourneyContract {
  readonly key: ContractKey;
  readonly id:
    | 'wp030-accountable-message-page/v1'
    | 'wp031-paid-service-page/v1'
    | 'wp032-clinical-coexistence-page/v1';
  readonly title: string;
  readonly endpoint: string;
  readonly actionKind:
    'accept-accountable-owner' | 'confirm-paid-service' | 'acknowledge-clinical-version';
  readonly localizedTitle: Readonly<Record<'en' | 'es', string>>;
  readonly localizedActionLabel: Readonly<Record<'en' | 'es', string>>;
  createAction(note: string): Readonly<Record<string, unknown>>;
  mount(page: Page, fixture: ContractFixture): Promise<void>;
  registerApi(page: Page, fixture: ContractFixture): Promise<void>;
  runPrimaryJourney(
    page: Page,
    fixture: ContractFixture,
    onTransition?: () => Promise<void>,
  ): Promise<SemanticState>;
  readSemanticState(page: Page): Promise<SemanticState>;
}
