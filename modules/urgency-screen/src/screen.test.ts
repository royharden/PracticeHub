import { describe, expect, it } from 'vitest';
import { assistiveAiScreen } from './ai-screen-double.js';
import { screenInbound } from './screen.js';
import {
  GOLDEN_SET_V1,
  LANDED_URGENCY_SCREEN,
  evaluateClassifier,
  runFailureDirectionSuite,
} from './triage-eval/index.js';
import { EMERGENCY_LINE, type ScreenLanguage, type UrgencyScreenInput } from './types.js';

function inbound(overrides: Partial<UrgencyScreenInput> = {}): UrgencyScreenInput {
  return {
    tenantId: 'tenant-synthetic-a',
    inboundId: 'inbound-1',
    receivedAt: '2026-09-18T03:00:00Z',
    channel: 'sms',
    language: 'en',
    text: 'Need a refill next week',
    unmatched: false,
    afterHours: true,
    killSwitchTripped: false,
    synthetic: true,
    ...overrides,
  };
}

describe('WP-045 urgency screen', () => {
  it('HAPPY: after-hours chest pain is urgent and pages on-call', () => {
    const fact = screenInbound(inbound({ text: 'I have chest pain' }));
    expect(fact.class).toBe('urgent');
    expect(fact.routing).toBe('page_oncall');
    expect(fact.advisoryOnly).toBe(true);
    expect(fact.emergencyLineRequired).toBe(true);
    expect(fact.reasons.some((reason) => reason.includes(EMERGENCY_LINE))).toBe(true);
  });

  it('HAPPY: after-hours refill is routine and queues until open', () => {
    const fact = screenInbound(inbound({ text: 'Need a refill next week' }));
    expect(fact.class).toBe('routine');
    expect(fact.routing).toBe('queue_until_open');
  });

  it('BOUNDARY: unmatched numbers still get content-first screening', () => {
    const fact = screenInbound(inbound({ unmatched: true, text: 'cannot breathe' }));
    expect(fact.unmatched).toBe(true);
    expect(fact.class).toBe('urgent');
    expect(fact.routing).toBe('page_oncall');
  });

  it('BOUNDARY: Spanish emergency language hits the same urgent class', () => {
    const fact = screenInbound(
      inbound({ language: 'es', text: 'Es una emergencia, dolor de pecho' }),
    );
    expect(fact.class).toBe('urgent');
    expect(fact.reasons.some((reason) => reason.includes('keyword:es:emergencia'))).toBe(true);
  });

  it('BOUNDARY: business-hours urgent content still classifies; it does not page', () => {
    const fact = screenInbound(inbound({ afterHours: false, text: 'stroke symptoms now' }));
    expect(fact.class).toBe('urgent');
    expect(fact.routing).toBe('queue_until_open');
  });

  it('FAILURE: kill-switch never silently routines; it forces human review', () => {
    const fact = screenInbound(
      inbound({ killSwitchTripped: true, text: 'Need a refill next week' }),
    );
    expect(fact.humanFallback).toBe(true);
    expect(fact.routing).toBe('human_review');
    expect(fact.class).toBe('urgent');
  });

  it('FAILURE: assistive AI cannot downgrade a keyword-urgent decision', () => {
    const ai = assistiveAiScreen({
      text: 'this looks calm actually',
      keywordClass: 'urgent',
      killSwitchTripped: false,
    });
    expect(ai.class).toBe('urgent');
    expect(ai.confidence).toBe(1);
  });

  it('RECOVERY: assistive AI may escalate a keyword-routine case', () => {
    const fact = screenInbound(inbound({ text: 'worst headache of my life' }));
    expect(fact.class).toBe('urgent');
    expect(fact.routing).toBe('page_oncall');
  });

  it('rejects non-synthetic inbound', () => {
    expect(() =>
      screenInbound({ ...inbound(), synthetic: false } as unknown as UrgencyScreenInput),
    ).toThrow(/synthetic inbound only/);
  });
});

/** The 23 fault-induced under-triages WP-104 attempt 1 found in the base screen. */
const BASE_INDUCED_UNDER_TRIAGE = [
  'en-u-02|curly-apostrophe',
  ...['en-u-01', 'en-u-02', 'en-u-03', 'en-u-08', 'en-u-09', 'en-u-10'].map(
    (id) => `${id}|extra-whitespace`,
  ),
  ...['es-u-01', 'es-u-02', 'es-u-06', 'un-u-04'].map((id) => `${id}|extra-whitespace`),
  ...['en-u-01', 'en-u-02', 'en-u-03', 'en-u-04', 'en-u-05', 'en-u-06', 'en-u-07', 'en-u-08'].map(
    (id) => `${id}|language-unknown`,
  ),
  ...['es-u-01', 'es-u-02', 'es-u-04', 'es-u-05'].map((id) => `${id}|language-unknown`),
];

/**
 * Paraphrases that appear nowhere in the golden set, at least two per WP-104 probe. Written by the
 * rework author, so they are not independent: a reviewer should add their own.
 */
const HELD_OUT_URGENT: readonly { probe: string; language: ScreenLanguage; text: string }[] = [
  { probe: 'pr-en-02', language: 'en', text: "I'm going to end my life tonight" },
  { probe: 'pr-en-02', language: 'en', text: 'I have pills saved up and I just want to die' },
  { probe: 'pr-en-02', language: 'en', text: 'been thinking about hurting myself again' },
  { probe: 'pr-en-03', language: 'en', text: 'my chest feels tight and my left arm is tingling' },
  { probe: 'pr-en-03', language: 'en', text: "there's a heavy squeezing feeling in my chest" },
  { probe: 'pr-en-03', language: 'en', text: 'sharp pain behind my breastbone' },
  { probe: 'pr-es-02', language: 'es', text: 'siento una presión fuerte en el pecho' },
  { probe: 'pr-es-02', language: 'es', text: 'tengo el pecho apretado y me sudan las manos' },
  { probe: 'pr-es-02', language: 'es', text: 'me aprieta el pecho desde hace una hora' },
  { probe: 'pr-es-01', language: 'es', text: 'ya no quiero vivir' },
  { probe: 'pr-es-01', language: 'es', text: 'voy a quitarme la vida' },
  { probe: 'pr-mis-01', language: 'es', text: "I'm really short of breath" },
  { probe: 'pr-un-01', language: 'unknown', text: 'me falta el aire' },
  { probe: 'en-u-10', language: 'en', text: 'his lips are blue' },
];

/** Near misses that must stay routine: an anchor with no qualifier, or neither. */
const ROUTINE_CONTROLS: readonly { language: ScreenLanguage; text: string }[] = [
  { language: 'en', text: 'Can I get a copy of my chest x-ray report?' },
  { language: 'en', text: 'My back hurts a little after the gym' },
  { language: 'en', text: 'Deep breathing exercises help me sleep' },
  { language: 'en', text: 'Can you send my blood pressure log to the clinic?' },
  { language: 'es', text: 'Necesito los resultados de la radiografía de pecho' },
  { language: 'unknown', text: 'Please cancel my Tuesday appointment' },
];

describe('WP-045 rework a2: normalization, vocabulary union and paraphrase coverage', () => {
  it('logs the ruleset version on every fact', () => {
    expect(screenInbound(inbound()).classifierVersion).toBe(
      'keyword-classifier.v4+ai-screen-double.v4',
    );
  });

  it('all 7 WP-104 golden probes now route urgent and page after hours', () => {
    const report = evaluateClassifier(LANDED_URGENCY_SCREEN, GOLDEN_SET_V1);
    expect(report.underTriage).toEqual([]);
    expect(report.urgentRecall).toBe(1);
    const probes = report.outcomes.filter((outcome) => outcome.source === 'probe');
    expect(probes).toHaveLength(7);
    expect(probes.every((outcome) => outcome.routing === 'page_oncall')).toBe(true);
    expect(report.matrixPasses).toBe(true);
  });

  it('all 23 fault-induced cases are safe and no fault is unsafe anywhere', () => {
    const report = runFailureDirectionSuite(LANDED_URGENCY_SCREEN, GOLDEN_SET_V1);
    expect(BASE_INDUCED_UNDER_TRIAGE).toHaveLength(23);
    const byKey = new Map(report.outcomes.map((outcome) => [outcome.key, outcome]));
    for (const key of BASE_INDUCED_UNDER_TRIAGE) {
      expect(byKey.get(key)?.safe, key).toBe(true);
      expect(byKey.get(key)?.observed, key).toBe('urgent');
    }
    expect(report.unsafe).toEqual([]);
  });

  it('the kill switch is safe on every golden case', () => {
    const report = runFailureDirectionSuite(LANDED_URGENCY_SCREEN, GOLDEN_SET_V1);
    const killSwitch = report.outcomes.filter((outcome) => outcome.fault === 'kill-switch');
    expect(killSwitch).toHaveLength(GOLDEN_SET_V1.cases.length);
    expect(killSwitch.every((outcome) => outcome.safe && outcome.routing === 'human_review')).toBe(
      true,
    );
  });

  it('held-out paraphrases route urgent in their own language, labelled unknown, or mislabelled', () => {
    for (const heldOut of HELD_OUT_URGENT) {
      for (const language of [heldOut.language, 'unknown', 'es', 'en'] as const) {
        const fact = screenInbound(inbound({ text: heldOut.text, language }));
        expect(fact.class, `${heldOut.probe} ${language}: ${heldOut.text}`).toBe('urgent');
        expect(fact.routing).toBe('page_oncall');
      }
    }
    expect(new Set(HELD_OUT_URGENT.map((item) => item.probe)).size).toBe(7);
  });

  it('near-miss routine messages stay routine; golden over-triage is unchanged', () => {
    for (const control of ROUTINE_CONTROLS) {
      const fact = screenInbound(inbound({ text: control.text, language: control.language }));
      expect(fact.class, control.text).toBe('routine');
    }
    const report = evaluateClassifier(LANDED_URGENCY_SCREEN, GOLDEN_SET_V1);
    expect(report.overTriage).toEqual(['en-r-05']);
  });

  it('reports which vocabulary or co-occurrence rule fired', () => {
    const chest = screenInbound(inbound({ text: 'crushing pressure in my chest', language: 'en' }));
    expect(chest.reasons).toContain('keyword:concept:chest-discomfort:chest+pressure');
    const mislabelled = screenInbound(inbound({ text: 'I cannot breathe', language: 'es' }));
    expect(mislabelled.reasons).toContain('keyword:en:cannot breathe');
  });
});

interface HeldOut {
  readonly id: string;
  readonly expected: 'urgent' | 'routine';
  readonly text: string;
}

/**
 * Reviewer 0194 held-out set, reviews/D56-WP-045-a2-review-1.heldout.json (sha256
 * ddd4e1c581254a6ba9f8b61599ba6eba909b30a8d62b8f050c4232c0f35f3800): 83 urgent, 20 routine.
 * Invisible and full-width characters are written as escapes.
 */
const REVIEWER_HELD_OUT: readonly HeldOut[] = [
  { id: 'en-sui-01', expected: 'urgent', text: "I don't want to be alive anymore" },
  { id: 'en-sui-02', expected: 'urgent', text: "I'm going to end things tonight" },
  { id: 'en-sui-03', expected: 'urgent', text: "I've been thinking about killing myself" },
  { id: 'en-sui-04', expected: 'urgent', text: 'I wish I was dead' },
  { id: 'en-sui-05', expected: 'urgent', text: 'I have a plan to hang myself' },
  { id: 'en-sui-06', expected: 'urgent', text: 'going to jump off the bridge after work' },
  { id: 'en-sui-07', expected: 'urgent', text: 'I took all my pills so it will finally stop' },
  { id: 'en-sui-08', expected: 'urgent', text: 'there is no reason for me to live anymore' },
  { id: 'en-sui-09', expected: 'urgent', text: "I'm going to shoot myself" },
  { id: 'en-sui-10', expected: 'urgent', text: 'I want to kil myself' },
  { id: 'en-sui-11', expected: 'urgent', text: 'thinking about ending it all' },
  { id: 'en-sui-12', expected: 'urgent', text: 'i want to die' },
  { id: 'en-sui-13', expected: 'urgent', text: 'Everyone would be better off without me' },
  { id: 'en-chest-01', expected: 'urgent', text: 'My chest feels tight and my left arm is numb' },
  { id: 'en-chest-02', expected: 'urgent', text: 'Feels like an elephant is sitting on my chest' },
  { id: 'en-chest-03', expected: 'urgent', text: 'I think I am having a heart attack' },
  { id: 'en-chest-04', expected: 'urgent', text: 'My chest is burning and I am sweating a lot' },
  { id: 'en-chest-05', expected: 'urgent', text: 'squeezing feeling behind my breastbone' },
  {
    id: 'en-chest-06',
    expected: 'urgent',
    text: 'sharp pain going into my jaw and left arm, feel sick and sweaty',
  },
  { id: 'en-br-01', expected: 'urgent', text: "I can't catch my breath" },
  { id: 'en-br-02', expected: 'urgent', text: "I'm gasping for air" },
  { id: 'en-br-03', expected: 'urgent', text: 'my throat is closing up after I ate peanuts' },
  { id: 'en-br-04', expected: 'urgent', text: 'my baby is not breathing' },
  { id: 'en-br-05', expected: 'urgent', text: 'I can not breathe' },
  { id: 'en-br-06', expected: 'urgent', text: 'struggling to breathe' },
  { id: 'en-br-07', expected: 'urgent', text: "can't get any air in" },
  { id: 'en-br-08', expected: 'urgent', text: 'he is choking and turning blue' },
  { id: 'en-br-09', expected: 'urgent', text: 'cant breath' },
  { id: 'en-br-10', expected: 'urgent', text: 'Short of breath and dizzy' },
  { id: 'en-stk-01', expected: 'urgent', text: 'Her face is drooping on one side' },
  { id: 'en-stk-02', expected: 'urgent', text: 'sudden numbness in my right arm and leg' },
  { id: 'en-stk-03', expected: 'urgent', text: 'his speech is slurred and he cannot lift his arm' },
  {
    id: 'en-stk-04',
    expected: 'urgent',
    text: 'my mom suddenly cant find her words and her face looks crooked',
  },
  { id: 'en-stk-05', expected: 'urgent', text: 'I think he is having a STROKE' },
  { id: 'en-oth-01', expected: 'urgent', text: 'he passed out and will not wake up' },
  { id: 'en-oth-02', expected: 'urgent', text: 'she is having a seizure that will not stop' },
  { id: 'en-oth-03', expected: 'urgent', text: 'bleeding heavily and it will not stop' },
  { id: 'en-oth-04', expected: 'urgent', text: 'please call an ambulance' },
  { id: 'es-sui-01', expected: 'urgent', text: 'me voy a matar' },
  { id: 'es-sui-02', expected: 'urgent', text: 'ya no quiero seguir viviendo' },
  { id: 'es-sui-03', expected: 'urgent', text: 'quisiera estar muerta' },
  { id: 'es-sui-04', expected: 'urgent', text: 'pienso en quitarme la vida' },
  { id: 'es-sui-05', expected: 'urgent', text: 'tengo ganas de morirme' },
  { id: 'es-sui-06', expected: 'urgent', text: 'me quiero morir' },
  { id: 'es-sui-07', expected: 'urgent', text: 'me corté las venas' },
  { id: 'es-sui-08', expected: 'urgent', text: 'Estoy pensando en suicidarme esta noche' },
  { id: 'es-chest-01', expected: 'urgent', text: 'siento una presión fuerte en el pecho' },
  { id: 'es-chest-02', expected: 'urgent', text: 'me duele el pecho y el brazo izquierdo' },
  { id: 'es-chest-03', expected: 'urgent', text: 'creo que me está dando un infarto' },
  { id: 'es-chest-04', expected: 'urgent', text: 'tengo un ataque al corazón' },
  { id: 'es-chest-05', expected: 'urgent', text: 'siento el pecho muy apretado' },
  { id: 'es-br-01', expected: 'urgent', text: 'me estoy ahogando' },
  { id: 'es-br-02', expected: 'urgent', text: 'no puedo respirar bien' },
  { id: 'es-br-03', expected: 'urgent', text: 'me falta el aire' },
  { id: 'es-br-04', expected: 'urgent', text: 'mi hijo no respira' },
  { id: 'es-br-05', expected: 'urgent', text: 'se está asfixiando' },
  { id: 'es-stk-01', expected: 'urgent', text: 'se le cayó la cara de un lado' },
  { id: 'es-stk-02', expected: 'urgent', text: 'no puede hablar y tiene el brazo dormido' },
  { id: 'es-stk-03', expected: 'urgent', text: 'creo que es un derrame cerebral' },
  { id: 'es-stk-04', expected: 'urgent', text: 'le dio un ictus' },
  { id: 'es-oth-01', expected: 'urgent', text: 'mi papá está inconsciente' },
  { id: 'es-oth-02', expected: 'urgent', text: 'sangra mucho y no para' },
  { id: 'es-oth-03', expected: 'urgent', text: 'tiene convulsiones' },
  { id: 'ty-01', expected: 'urgent', text: 'I can\u{2019}t breathe' },
  { id: 'ty-02', expected: 'urgent', text: 'chest\u{a0}pain' },
  { id: 'ty-03', expected: 'urgent', text: 'I want to ki\u{200b}ll myself' },
  { id: 'ty-04', expected: 'urgent', text: 'thinking about sui\u{ad}cide' },
  { id: 'ty-05', expected: 'urgent', text: 'chest pa\u{200d}in' },
  {
    id: 'ty-06',
    expected: 'urgent',
    text: '\u{ff43}\u{ff48}\u{ff45}\u{ff53}\u{ff54}\u{3000}\u{ff50}\u{ff41}\u{ff49}\u{ff4e}',
  },
  { id: 'ty-07', expected: 'urgent', text: 'dolor de pe\u{301}cho' },
  { id: 'ty-08', expected: 'urgent', text: 'SUICIDE' },
  { id: 'ty-09', expected: 'urgent', text: '   chest \u{9}\u{a}   pain   ' },
  { id: 'ty-10', expected: 'urgent', text: 'ChEsT PaIn' },
  { id: 'ty-11', expected: 'urgent', text: 'I can\u{ff07}t breathe' },
  { id: 'ty-12', expected: 'urgent', text: 'I can\u{200c}t breathe' },
  { id: 'ty-13', expected: 'urgent', text: 'I CAN\u{2018}T BREATHE' },
  { id: 'ty-14', expected: 'urgent', text: 'overdose\u{fe0f}' },
  { id: 'ty-15', expected: 'urgent', text: 'QUIERO QUITARME LA VIDA' },
  { id: 'ty-16', expected: 'urgent', text: 'hacerme dan\u{303}o' },
  {
    id: 'ty-17',
    expected: 'urgent',
    text: '\u{ff33}\u{ff35}\u{ff29}\u{ff23}\u{ff29}\u{ff24}\u{ff25}',
  },
  { id: 'ty-18', expected: 'urgent', text: 'kill\u{2060}myself' },
  { id: 'ty-19', expected: 'urgent', text: 'cant\u{a0}\u{a0}\u{a0}breathe' },
  { id: 'ty-20', expected: 'urgent', text: 'emergen\u{200b}cy' },
  { id: 'rt-01', expected: 'routine', text: 'I need a refill of my chest pain medication' },
  { id: 'rt-02', expected: 'routine', text: 'The chest x-ray results came back fine, thanks' },
  { id: 'rt-03', expected: 'routine', text: 'I need to update my emergency contact' },
  {
    id: 'rt-04',
    expected: 'routine',
    text: 'I hurt myself playing tennis last month, can I book physical therapy',
  },
  {
    id: 'rt-05',
    expected: 'routine',
    text: 'Tips for heat stroke prevention for my running club?',
  },
  {
    id: 'rt-06',
    expected: 'routine',
    text: 'My daughter lips are purple from the grape popsicle lol',
  },
  {
    id: 'rt-07',
    expected: 'routine',
    text: 'The breathing treatment form is hard to find on the portal',
  },
  { id: 'rt-08', expected: 'routine', text: 'Vivo en Buenos Aires, cuanto cuesta la consulta?' },
  {
    id: 'rt-09',
    expected: 'routine',
    text: 'El aire acondicionado de la sala de espera no funciona, falta mantenimiento',
  },
  { id: 'rt-10', expected: 'routine', text: 'Please call me back at 555 911 2233' },
  { id: 'rt-11', expected: 'routine', text: 'Can I reschedule my appointment to Thursday' },
  { id: 'rt-12', expected: 'routine', text: 'What are your office hours on Saturday' },
  { id: 'rt-13', expected: 'routine', text: 'I would like to cancel my membership' },
  { id: 'rt-14', expected: 'routine', text: 'Quisiera cambiar mi cita para el martes' },
  { id: 'rt-15', expected: 'routine', text: 'Cuanto cuesta la membresia anual' },
  {
    id: 'rt-16',
    expected: 'routine',
    text: 'My chest workout was heavy today, can you recommend a protein shake',
  },
  { id: 'rt-17', expected: 'routine', text: 'I want to die my hair before the photo day' },
  { id: 'rt-18', expected: 'routine', text: 'Can I get a short note that I can return to work' },
  { id: 'rt-19', expected: 'routine', text: 'Is the decanter set I left in the lobby still there' },
  {
    id: 'rt-20',
    expected: 'routine',
    text: 'Necesito la receta de mi inhalador, respirar con el nuevo es mas facil',
  },
];

/**
 * D56 own held-out sets, each hashed before its first run (v1 a3f0cc13..., v2 d51ab98d...,
 * v3 21d68269...). First-run recall: v1 39/46, v2 19/36, v3 17/30. Every miss after the first
 * run was fixed by concept except the two in KNOWN_KEYWORD_GAPS.
 */
const OWN_HELD_OUT: readonly HeldOut[] = [
  {
    id: 'oh-en-01',
    expected: 'urgent',
    text: 'i think im going to kill myself tonight, i have the pills ready',
  },
  {
    id: 'oh-en-02',
    expected: 'urgent',
    text: 'I keep thinking everyone would be happier if I was gone',
  },
  { id: 'oh-en-03', expected: 'urgent', text: "I bought a rope and I know what I'm going to do" },
  { id: 'oh-en-04', expected: 'urgent', text: "can't stop thinking about ending my life" },
  {
    id: 'oh-en-05',
    expected: 'urgent',
    text: "I've been cutting myself again and it's deep this time",
  },
  { id: 'oh-en-06', expected: 'urgent', text: 'I swallowed a whole bottle of tylenol an hour ago' },
  {
    id: 'oh-en-07',
    expected: 'urgent',
    text: 'my dad is clutching his chest and sweating buckets',
  },
  {
    id: 'oh-en-08',
    expected: 'urgent',
    text: 'tight squeezing in my chest that goes down my left arm',
  },
  { id: 'oh-en-09', expected: 'urgent', text: 'feels like my heart is being crushed' },
  { id: 'oh-en-10', expected: 'urgent', text: 'I think my husband is having a heart attack' },
  { id: 'oh-en-11', expected: 'urgent', text: "my son can't breathe, his lips are turning blue" },
  {
    id: 'oh-en-12',
    expected: 'urgent',
    text: "struggling to get air in, wheezing badly and my inhaler isn't working",
  },
  { id: 'oh-en-13', expected: 'urgent', text: "she's choking on something and can't cough it out" },
  { id: 'oh-en-14', expected: 'urgent', text: 'my throat is swelling up after the bee sting' },
  {
    id: 'oh-en-15',
    expected: 'urgent',
    text: "grandma's face looks droopy and her words are all jumbled",
  },
  { id: 'oh-en-16', expected: 'urgent', text: "he suddenly can't move his left side" },
  { id: 'oh-en-17', expected: 'urgent', text: "my wife collapsed and isn't responding to me" },
  { id: 'oh-en-18', expected: 'urgent', text: "found my brother on the floor, he won't wake up" },
  {
    id: 'oh-en-19',
    expected: 'urgent',
    text: "my daughter is having a seizure right now and it hasn't stopped",
  },
  {
    id: 'oh-en-20',
    expected: 'urgent',
    text: "cut my hand badly and the blood won't stop, it's soaking through towels",
  },
  { id: 'oh-en-21', expected: 'urgent', text: 'please send an ambulance to my house' },
  { id: 'oh-en-22', expected: 'urgent', text: 'vomiting blood right now' },
  {
    id: 'oh-en-23',
    expected: 'urgent',
    text: 'worst headache ever came on suddenly like a thunderclap',
  },
  { id: 'oh-en-24', expected: 'urgent', text: 'I took too many of my sleeping pills on purpose' },
  {
    id: 'oh-en-25',
    expected: 'urgent',
    text: "I feel like I'm going to pass out and my chest hurts",
  },
  { id: 'oh-en-26', expected: 'urgent', text: "my baby isn't breathing right, she's gasping" },
  { id: 'oh-en-27', expected: 'urgent', text: "I can hardly breathe and I'm dizzy" },
  {
    id: 'oh-en-28',
    expected: 'urgent',
    text: 'sudden weakness in my right leg and my speech sounds weird',
  },
  { id: 'oh-es-01', expected: 'urgent', text: 'ya no aguanto más, quiero quitarme la vida' },
  { id: 'oh-es-02', expected: 'urgent', text: 'tengo un plan para matarme esta noche' },
  { id: 'oh-es-03', expected: 'urgent', text: 'me tomé un frasco entero de pastillas' },
  { id: 'oh-es-04', expected: 'urgent', text: 'siento un peso en el pecho y me sudan las manos' },
  { id: 'oh-es-05', expected: 'urgent', text: 'me duele el pecho y el brazo izquierdo' },
  { id: 'oh-es-06', expected: 'urgent', text: 'creo que mi esposo está teniendo un infarto' },
  { id: 'oh-es-07', expected: 'urgent', text: 'no puedo respirar bien, me estoy ahogando' },
  {
    id: 'oh-es-08',
    expected: 'urgent',
    text: 'a mi hijo le falta el aire y tiene los labios morados',
  },
  {
    id: 'oh-es-09',
    expected: 'urgent',
    text: 'mi mamá tiene la boca chueca y no puede hablar bien',
  },
  { id: 'oh-es-10', expected: 'urgent', text: 'de repente no siento el brazo derecho' },
  { id: 'oh-es-11', expected: 'urgent', text: 'mi papá se desmayó y no despierta' },
  { id: 'oh-es-12', expected: 'urgent', text: 'mi hija está convulsionando y no para' },
  { id: 'oh-es-13', expected: 'urgent', text: 'se cortó y está sangrando muchísimo' },
  { id: 'oh-es-14', expected: 'urgent', text: 'necesito una ambulancia urgente' },
  { id: 'oh-es-15', expected: 'urgent', text: 'estoy vomitando sangre' },
  { id: 'oh-es-16', expected: 'urgent', text: 'se le hinchó la garganta y no puede tragar' },
  { id: 'oh-es-17', expected: 'urgent', text: 'mi abuelo no responde' },
  {
    id: 'oh-es-18',
    expected: 'urgent',
    text: 'siento que me voy a morir, me duele mucho el pecho',
  },
  { id: 'or-01', expected: 'routine', text: 'Can I get my allergy medication refilled?' },
  { id: 'or-02', expected: 'routine', text: 'What time does the clinic open on Saturday?' },
  { id: 'or-03', expected: 'routine', text: 'I need to reschedule my physical' },
  { id: 'or-04', expected: 'routine', text: 'Is my chest x-ray result back yet?' },
  {
    id: 'or-05',
    expected: 'routine',
    text: 'My knee hurts when I run, can I book a visit next week?',
  },
  { id: 'or-06', expected: 'routine', text: 'Please send my records to my new dentist' },
  { id: 'or-07', expected: 'routine', text: 'How much does the membership cost per month?' },
  { id: 'or-08', expected: 'routine', text: 'Do you accept my insurance?' },
  { id: 'or-09', expected: 'routine', text: 'I would like a flu shot' },
  {
    id: 'or-10',
    expected: 'routine',
    text: 'Can the doctor call me about my blood pressure numbers from last week?',
  },
  { id: 'or-11', expected: 'routine', text: '\u{bf}Cuánto cuesta la consulta?' },
  { id: 'or-12', expected: 'routine', text: 'Vivo en Buenos Aires y quiero una cita virtual' },
  { id: 'or-13', expected: 'routine', text: '\u{bf}El aire acondicionado de la sala funciona?' },
  { id: 'or-14', expected: 'routine', text: 'Necesito renovar mi receta de la presión' },
  { id: 'or-15', expected: 'routine', text: '\u{bf}Puedo cambiar mi cita para el viernes?' },
  { id: 'or-16', expected: 'routine', text: 'Gracias por la atención de ayer' },
  { id: 'or-17', expected: 'routine', text: "I need a form for my kid's school" },
  { id: 'or-18', expected: 'routine', text: 'Can I get a refill on my seizure medication?' },
  { id: 'or-19', expected: 'routine', text: 'Following up on my sleep study results' },
  {
    id: 'or-20',
    expected: 'routine',
    text: 'My heart rate monitor app shows my resting rate went down, nice!',
  },
  { id: 'or-21', expected: 'routine', text: "Thanks, I'm feeling much better now" },
  { id: 'or-22', expected: 'routine', text: 'Where do I park for my appointment?' },
  {
    id: 'o2-en-01',
    expected: 'urgent',
    text: "I have a gun and I'm thinking of using it on myself",
  },
  { id: 'o2-en-02', expected: 'urgent', text: "I don't see the point of living anymore" },
  { id: 'o2-en-03', expected: 'urgent', text: 'I wrote goodbye letters to my family' },
  { id: 'o2-en-04', expected: 'urgent', text: "I can't go on like this, I want it all to end" },
  {
    id: 'o2-en-05',
    expected: 'urgent',
    text: "took a bunch of my mom's pills, feeling really sleepy",
  },
  {
    id: 'o2-en-06',
    expected: 'urgent',
    text: 'pressure in the middle of my chest for 20 minutes and I feel sick',
  },
  {
    id: 'o2-en-07',
    expected: 'urgent',
    text: "my chest feels tight and I'm breaking out in a cold sweat",
  },
  {
    id: 'o2-en-08',
    expected: 'urgent',
    text: 'my husband is gray and sweaty and says his chest hurts',
  },
  { id: 'o2-en-09', expected: 'urgent', text: 'my toddler swallowed a button battery' },
  { id: 'o2-en-10', expected: 'urgent', text: "she's wheezing and her lips look bluish" },
  {
    id: 'o2-en-11',
    expected: 'urgent',
    text: "I'm having an allergic reaction and my tongue is getting big",
  },
  { id: 'o2-en-12', expected: 'urgent', text: "my father's face suddenly went numb on one side" },
  {
    id: 'o2-en-13',
    expected: 'urgent',
    text: "she's talking gibberish and can't lift her right arm",
  },
  {
    id: 'o2-en-14',
    expected: 'urgent',
    text: "my son hit his head and now he's not making sense and throwing up",
  },
  { id: 'o2-en-15', expected: 'urgent', text: "my grandpa won't respond when I shake him" },
  { id: 'o2-en-16', expected: 'urgent', text: "she's been seizing for five minutes" },
  { id: 'o2-en-17', expected: 'urgent', text: 'the cut is spurting blood' },
  { id: 'o2-en-18', expected: 'urgent', text: "I'm pregnant and bleeding a lot" },
  {
    id: 'o2-es-01',
    expected: 'urgent',
    text: 'tengo una pistola y estoy pensando en usarla contra mí',
  },
  { id: 'o2-es-02', expected: 'urgent', text: 'ya no le veo sentido a vivir' },
  { id: 'o2-es-03', expected: 'urgent', text: 'quiero desaparecer para siempre' },
  { id: 'o2-es-04', expected: 'urgent', text: 'me quiero morir, ya no puedo más' },
  { id: 'o2-es-05', expected: 'urgent', text: 'mi mamá se tomó todas sus pastillas' },
  { id: 'o2-es-06', expected: 'urgent', text: 'tengo una opresión fuerte en el pecho' },
  { id: 'o2-es-07', expected: 'urgent', text: 'me duele la mandíbula y el brazo izquierdo' },
  { id: 'o2-es-08', expected: 'urgent', text: 'siento que me aprieta el corazón' },
  { id: 'o2-es-09', expected: 'urgent', text: 'mi bebé no puede respirar' },
  { id: 'o2-es-10', expected: 'urgent', text: 'se está poniendo morado y no respira bien' },
  { id: 'o2-es-11', expected: 'urgent', text: 'se me hinchó la lengua después de comer mariscos' },
  { id: 'o2-es-12', expected: 'urgent', text: 'mi papá tiene la cara torcida' },
  { id: 'o2-es-13', expected: 'urgent', text: 'mi abuela no puede mover el lado izquierdo' },
  { id: 'o2-es-14', expected: 'urgent', text: 'habla raro y no se le entiende nada' },
  { id: 'o2-es-15', expected: 'urgent', text: 'mi esposo se desmayó en el baño' },
  { id: 'o2-es-16', expected: 'urgent', text: 'mi hijo tiene una convulsión y no para' },
  { id: 'o2-es-17', expected: 'urgent', text: 'estoy sangrando mucho después del parto' },
  { id: 'o2-es-18', expected: 'urgent', text: 'llamen a una ambulancia por favor' },
  { id: 'o2r-01', expected: 'routine', text: 'Can I get a copy of my heart monitor report?' },
  { id: 'o2r-02', expected: 'routine', text: 'Is the pharmacy open late tonight?' },
  { id: 'o2r-03', expected: 'routine', text: 'My daughter needs her vaccine records' },
  { id: 'o2r-04', expected: 'routine', text: "I'd like to talk to someone about my bill" },
  { id: 'o2r-05', expected: 'routine', text: 'Do you have openings for a physical next month?' },
  {
    id: 'o2r-06',
    expected: 'routine',
    text: 'Can I switch my appointment to the Henderson location?',
  },
  {
    id: 'o2r-07',
    expected: 'routine',
    text: '\u{bf}Me pueden mandar mis resultados de laboratorio?',
  },
  { id: 'o2r-08', expected: 'routine', text: '\u{bf}A qué hora cierran hoy?' },
  { id: 'o2r-09', expected: 'routine', text: 'Quiero hacer una cita para mi hijo' },
  { id: 'o2r-10', expected: 'routine', text: '\u{bf}Aceptan mi seguro médico?' },
  { id: 'o2r-11', expected: 'routine', text: 'My chest cold is getting better, thanks' },
  { id: 'o2r-12', expected: 'routine', text: 'I lost my inhaler, can I get a new prescription?' },
  { id: 'o3-en-01', expected: 'urgent', text: "i'm done with life, tonight is the night" },
  {
    id: 'o3-en-02',
    expected: 'urgent',
    text: "I've been stockpiling my meds so I can take them all at once",
  },
  { id: 'o3-en-03', expected: 'urgent', text: "I'm standing on the roof and thinking of jumping" },
  { id: 'o3-en-04', expected: 'urgent', text: "honestly I'd rather not wake up tomorrow" },
  {
    id: 'o3-en-05',
    expected: 'urgent',
    text: "chest pressure radiating to my back and I'm nauseous",
  },
  {
    id: 'o3-en-06',
    expected: 'urgent',
    text: 'heart racing and chest is really tight, I think something is wrong',
  },
  {
    id: 'o3-en-07',
    expected: 'urgent',
    text: "my mom's lips turned blue and she's barely breathing",
  },
  { id: 'o3-en-08', expected: 'urgent', text: 'my kid ate some of my blood pressure pills' },
  {
    id: 'o3-en-09',
    expected: 'urgent',
    text: "he's having trouble speaking and one side of his face is numb",
  },
  {
    id: 'o3-en-10',
    expected: 'urgent',
    text: 'sudden vision loss in one eye and my arm feels weak',
  },
  { id: 'o3-en-11', expected: 'urgent', text: "my father fell and isn't moving or answering" },
  { id: 'o3-en-12', expected: 'urgent', text: 'she keeps having seizures one after another' },
  { id: 'o3-en-13', expected: 'urgent', text: "I cut my wrist and it won't stop bleeding" },
  {
    id: 'o3-en-14',
    expected: 'urgent',
    text: "throat feels tight after the new antibiotic and I'm wheezing",
  },
  { id: 'o3-en-15', expected: 'urgent', text: 'my husband is confused and his speech is garbled' },
  { id: 'o3-es-01', expected: 'urgent', text: 'ya no quiero estar aquí, quiero que todo termine' },
  { id: 'o3-es-02', expected: 'urgent', text: 'voy a tirarme del puente' },
  {
    id: 'o3-es-03',
    expected: 'urgent',
    text: 'estoy pensando en tomarme todas las pastillas del cajón',
  },
  {
    id: 'o3-es-04',
    expected: 'urgent',
    text: 'me siento muy mal, me aprieta el pecho y sudo frío',
  },
  { id: 'o3-es-05', expected: 'urgent', text: 'tengo dolor fuerte que se va al brazo izquierdo' },
  { id: 'o3-es-06', expected: 'urgent', text: 'mi hijo se está ahogando con comida' },
  { id: 'o3-es-07', expected: 'urgent', text: 'no puede respirar y tiene los labios grises' },
  { id: 'o3-es-08', expected: 'urgent', text: 'a mi papá se le durmió la mitad de la cara' },
  { id: 'o3-es-09', expected: 'urgent', text: 'mi mamá no puede mover el brazo ni hablar' },
  { id: 'o3-es-10', expected: 'urgent', text: 'encontré a mi esposo tirado y no reacciona' },
  { id: 'o3-es-11', expected: 'urgent', text: 'mi nieto está teniendo convulsiones' },
  {
    id: 'o3-es-12',
    expected: 'urgent',
    text: 'estoy sangrando sin parar de la nariz desde hace una hora',
  },
  { id: 'o3-es-13', expected: 'urgent', text: 'después de la inyección se me cerró la garganta' },
  { id: 'o3-es-14', expected: 'urgent', text: 'se tomó un veneno para ratas' },
  { id: 'o3-es-15', expected: 'urgent', text: 'por favor manden una ambulancia, es urgente' },
  {
    id: 'o3r-01',
    expected: 'routine',
    text: 'Could you send the chest pain medication refill to CVS?',
  },
  { id: 'o3r-02', expected: 'routine', text: "What's the copay for a telehealth visit?" },
  { id: 'o3r-03', expected: 'routine', text: 'Please remind me of my next appointment' },
  { id: 'o3r-04', expected: 'routine', text: 'I left my umbrella in the waiting room' },
  {
    id: 'o3r-05',
    expected: 'routine',
    text: 'Can I get a letter for my gym about my heart health?',
  },
  {
    id: 'o3r-06',
    expected: 'routine',
    text: 'My breathing is much better since starting the new inhaler, thank you',
  },
  { id: 'o3r-07', expected: 'routine', text: '\u{bf}Pueden enviar la factura a mi correo?' },
  { id: 'o3r-08', expected: 'routine', text: 'Necesito un certificado médico para el trabajo' },
  { id: 'o3r-09', expected: 'routine', text: '\u{bf}Tienen estacionamiento?' },
  { id: 'o3r-10', expected: 'routine', text: 'Mi cita es a las 3, \u{bf}llego 15 minutos antes?' },
  { id: 'o3r-11', expected: 'routine', text: 'Is the flu vaccine available for kids?' },
  {
    id: 'o3r-12',
    expected: 'routine',
    text: 'My dad had a stroke last year, can he see the neurologist again?',
  },
];

/**
 * Two paraphrases the keyword screen still misses. They are pinned so that both a fix and a
 * regression show up. A keyword screen cannot reach perfect recall on unseen phrasing.
 */
const KNOWN_KEYWORD_GAPS = ['oh-en-03', 'o2-en-05'];

/**
 * Routine messages in the reviewer and own sets that still escalate: a historical mention, an
 * idiom, a number containing 911. Over-triage is the accepted direction; this list is exact so
 * that an increase is seen. a4 (integrator decision: union with a2 and landed) brings back a2's
 * substring false positives rt-08 ('Buenos Aires ... cuesta') and rt-09 ('aire acondicionado ...
 * falta'): a3 had removed them, and the union restores them by construction.
 */
const ACCEPTED_OVER_TRIAGE = [
  'rt-01',
  'rt-03',
  'rt-04',
  'rt-05',
  'rt-06',
  'rt-07',
  'rt-08',
  'rt-09',
  'rt-10',
  'rt-16',
  'rt-17',
  'o3r-01',
  'o3r-12',
];

const LABELS = ['en', 'es', 'unknown'] as const;

function underEveryLabel(text: string) {
  return LABELS.map((language) => screenInbound(inbound({ text, language })));
}

describe('WP-045 rework 2 (a3): concept coverage, whole-word matching, format characters', () => {
  it('ACCEPTANCE 1: all 83 reviewer urgent held-outs route urgent and page under every label', () => {
    const urgent = REVIEWER_HELD_OUT.filter((item) => item.expected === 'urgent');
    expect(urgent).toHaveLength(83);
    const missed = urgent.filter((item) =>
      underEveryLabel(item.text).some(
        (fact) => fact.class !== 'urgent' || fact.routing !== 'page_oncall',
      ),
    );
    expect(missed.map((item) => item.id)).toEqual([]);
  });

  it('own held-out urgent cases route urgent under every label, except the pinned gaps', () => {
    const urgent = OWN_HELD_OUT.filter((item) => item.expected === 'urgent');
    expect(urgent).toHaveLength(112);
    const missed = urgent.filter((item) =>
      underEveryLabel(item.text).some((fact) => fact.class !== 'urgent'),
    );
    expect(missed.map((item) => item.id)).toEqual(KNOWN_KEYWORD_GAPS);
  });

  it('over-triage is exact: a2 false positives return under the union, the rest stay routine', () => {
    const routine = [...REVIEWER_HELD_OUT, ...OWN_HELD_OUT].filter(
      (item) => item.expected === 'routine',
    );
    expect(routine).toHaveLength(66);
    const escalated = routine
      .filter((item) => underEveryLabel(item.text).some((fact) => fact.class === 'urgent'))
      .map((item) => item.id);
    expect(escalated).toEqual(ACCEPTED_OVER_TRIAGE);
    for (const id of ['rt-15', 'or-11', 'or-12', 'or-13']) {
      expect(escalated, id).not.toContain(id);
    }
  });

  it('the kill switch hands every held-out text to a human as urgent', () => {
    for (const item of [...REVIEWER_HELD_OUT, ...OWN_HELD_OUT]) {
      const fact = screenInbound(inbound({ text: item.text, killSwitchTripped: true }));
      expect(fact.humanFallback, item.id).toBe(true);
      expect(fact.routing, item.id).toBe('human_review');
      expect(fact.class, item.id).toBe('urgent');
    }
  });

  it('reads a format character both as deleted and as a word break', () => {
    const zwsp = String.fromCodePoint(0x200b);
    expect(screenInbound(inbound({ text: `I want to ki${zwsp}ll myself` })).class).toBe('urgent');
    expect(screenInbound(inbound({ text: `I want to kill${zwsp}myself` })).class).toBe('urgent');
  });

  it('names the concept rule that fired', () => {
    const stroke = screenInbound(
      inbound({ text: 'se le cayó la cara de un lado', language: 'es' }),
    );
    expect(stroke.reasons).toContain('keyword:concept:stroke-face:cara+cay*');
    const child = screenInbound(inbound({ text: 'my kid ate some of my blood pressure pills' }));
    expect(child.reasons).toContain('keyword:concept:dangerous-ingestion:kid+ate+pill*');
  });
});

/**
 * Reviewer 0196 held-out set, reviews/D56-WP-045-a3-review-2.heldout.json (sha256
 * 5fa3a65f438c4b038ce87f2eca40d67a0345d4d2af7b05ec1de980e5bf2c86ef): 110 urgent, 39 routine.
 */
const REVIEWER_0196_HELD_OUT: readonly HeldOut[] = [
  {
    id: 'h2-en-sh-01',
    expected: 'urgent',
    text: "I've decided tonight is the night I end things. I just wanted someone to know.",
  },
  {
    id: 'h2-en-sh-02',
    expected: 'urgent',
    text: "I can't keep going like this, I'm planning to take all my sleeping pills after my wife goes to bed",
  },
  {
    id: 'h2-en-sh-03',
    expected: 'urgent',
    text: "There's no point anymore. Everyone would be better off without me around.",
  },
  {
    id: 'h2-en-sh-04',
    expected: 'urgent',
    text: "I cut my wrists deeper than usual and it won't stop bleeding",
  },
  { id: 'h2-en-sh-05', expected: 'urgent', text: 'I have the gun loaded on the table next to me' },
  {
    id: 'h2-en-sh-06',
    expected: 'urgent',
    text: "Please tell my doctor thank you for everything. I won't need the appointment next week because I won't be here.",
  },
  { id: 'h2-en-sh-07', expected: 'urgent', text: 'I swallowed about 30 of my tylenol an hour ago' },
  {
    id: 'h2-en-sh-08',
    expected: 'urgent',
    text: 'thinking about driving my car into the bridge pillar on the way home',
  },
  { id: 'h2-en-sh-09', expected: 'urgent', text: 'i want to die' },
  {
    id: 'h2-en-sh-10',
    expected: 'urgent',
    text: "My son (17) says he's going to hang himself, he's locked in his room",
  },
  { id: 'h2-en-sh-11', expected: 'urgent', text: 'I overdosed on my meds on purpose' },
  {
    id: 'h2-en-acs-01',
    expected: 'urgent',
    text: 'Crushing pressure in the middle of my chest for 20 minutes, and my left arm feels heavy',
  },
  {
    id: 'h2-en-acs-02',
    expected: 'urgent',
    text: "My husband is sweaty and pale and says there's an elephant sitting on his chest",
  },
  {
    id: 'h2-en-acs-03',
    expected: 'urgent',
    text: "Pain spreading from my chest up into my jaw, feel like I'm going to throw up",
  },
  { id: 'h2-en-acs-04', expected: 'urgent', text: "I think I'm having a heart attack" },
  {
    id: 'h2-en-acs-05',
    expected: 'urgent',
    text: "Tightness in my chest that started while shoveling snow and hasn't gone away, I'm short of breath",
  },
  {
    id: 'h2-en-acs-06',
    expected: 'urgent',
    text: "My dad is 70, clutching his chest and can't catch his breath",
  },
  { id: 'h2-en-br-01', expected: 'urgent', text: "I can't breathe" },
  {
    id: 'h2-en-br-02',
    expected: 'urgent',
    text: "My inhaler isn't working and I can barely get words out",
  },
  {
    id: 'h2-en-br-03',
    expected: 'urgent',
    text: "My lips are turning blue and I'm struggling for air",
  },
  { id: 'h2-en-br-04', expected: 'urgent', text: "He is choking on food and can't cough or talk" },
  { id: 'h2-en-br-05', expected: 'urgent', text: "I'm wheezing so hard I can't finish a sentence" },
  {
    id: 'h2-en-br-06',
    expected: 'urgent',
    text: "Woke up gasping and I still can't get enough air",
  },
  {
    id: 'h2-en-st-01',
    expected: 'urgent',
    text: "Half of my mom's face is drooping and her words are coming out garbled",
  },
  {
    id: 'h2-en-st-02',
    expected: 'urgent',
    text: "Suddenly I can't lift my right arm and my right leg is numb",
  },
  {
    id: 'h2-en-st-03',
    expected: 'urgent',
    text: "My husband can't find his words and is confused, started 30 minutes ago",
  },
  {
    id: 'h2-en-st-04',
    expected: 'urgent',
    text: 'Worst headache of my life came on all at once like a thunderclap',
  },
  {
    id: 'h2-en-st-05',
    expected: 'urgent',
    text: 'I suddenly lost vision in one eye and my speech is slurred',
  },
  { id: 'h2-en-un-01', expected: 'urgent', text: "My grandfather collapsed and won't wake up" },
  {
    id: 'h2-en-un-02',
    expected: 'urgent',
    text: "She passed out and isn't responding when I shake her",
  },
  {
    id: 'h2-en-un-03',
    expected: 'urgent',
    text: 'Found my roommate on the floor, unresponsive, barely breathing',
  },
  { id: 'h2-en-un-04', expected: 'urgent', text: 'He fainted and hit his head and is still out' },
  {
    id: 'h2-en-sz-01',
    expected: 'urgent',
    text: "My daughter has been seizing for over 5 minutes and it isn't stopping",
  },
  {
    id: 'h2-en-sz-02',
    expected: 'urgent',
    text: "He's having one seizure after another and not waking up in between",
  },
  {
    id: 'h2-en-sz-03',
    expected: 'urgent',
    text: 'Convulsing on the floor right now, what do I do',
  },
  {
    id: 'h2-en-sz-04',
    expected: 'urgent',
    text: "First seizure ever, she's shaking all over and foaming at the mouth",
  },
  {
    id: 'h2-en-bl-01',
    expected: 'urgent',
    text: "Blood is soaking through every towel, the cut on my leg won't stop bleeding",
  },
  { id: 'h2-en-bl-02', expected: 'urgent', text: "I'm throwing up blood, bright red" },
  {
    id: 'h2-en-bl-03',
    expected: 'urgent',
    text: "Black tarry stool and I feel like I'm going to pass out",
  },
  {
    id: 'h2-en-bl-04',
    expected: 'urgent',
    text: "Nosebleed for an hour that won't stop, I'm on blood thinners and dizzy",
  },
  { id: 'h2-en-bl-05', expected: 'urgent', text: 'Gushing blood from a deep cut on my hand' },
  { id: 'h2-en-an-01', expected: 'urgent', text: 'My throat is closing after eating shrimp' },
  {
    id: 'h2-en-an-02',
    expected: 'urgent',
    text: 'Stung by a bee, face swelling fast and hard to breathe',
  },
  {
    id: 'h2-en-an-03',
    expected: 'urgent',
    text: 'Tongue and lips swelling up after the new antibiotic, hives everywhere',
  },
  {
    id: 'h2-en-an-04',
    expected: 'urgent',
    text: 'Used my EpiPen but the swelling in my throat is getting worse',
  },
  { id: 'h2-en-pd-01', expected: 'urgent', text: 'My 2 year old swallowed a button battery' },
  { id: 'h2-en-pd-02', expected: 'urgent', text: 'Baby is 5 weeks old with a fever of 101' },
  {
    id: 'h2-en-pd-03',
    expected: 'urgent',
    text: 'My toddler got into the dishwasher pods and ate one',
  },
  {
    id: 'h2-en-pd-04',
    expected: 'urgent',
    text: "My infant is limp and won't feed, very hard to wake",
  },
  {
    id: 'h2-en-pd-05',
    expected: 'urgent',
    text: "My son's lips are blue and he's making a whistling sound breathing in",
  },
  { id: 'h2-en-pd-06', expected: 'urgent', text: '4 year old drank some of the lamp oil' },
  {
    id: 'h2-en-pd-07',
    expected: 'urgent',
    text: 'My baby stopped breathing for a few seconds and turned gray',
  },
  { id: 'h2-en-ob-01', expected: 'urgent', text: "I'm 34 weeks pregnant and bleeding heavily" },
  {
    id: 'h2-en-ob-02',
    expected: 'urgent',
    text: '32 weeks pregnant with a pounding headache, seeing spots, and my face is swollen',
  },
  { id: 'h2-en-ob-03', expected: 'urgent', text: 'My water broke and I can feel the cord' },
  {
    id: 'h2-en-ob-04',
    expected: 'urgent',
    text: "I'm 8 weeks pregnant and have severe one-sided pain and feel faint",
  },
  {
    id: 'h2-en-ob-05',
    expected: 'urgent',
    text: "Haven't felt the baby move all day, I'm 36 weeks",
  },
  {
    id: 'h2-en-ob-06',
    expected: 'urgent',
    text: "Gave birth last week and I'm soaking a pad every 30 minutes",
  },
  {
    id: 'h2-en-em-01',
    expected: 'urgent',
    text: "Please call 911 for me, I'm at home alone and can't get up",
  },
  { id: 'h2-en-em-02', expected: 'urgent', text: 'I need an ambulance' },
  {
    id: 'h2-es-sh-01',
    expected: 'urgent',
    text: 'Ya no quiero vivir, esta noche me voy a quitar la vida',
  },
  { id: 'h2-es-sh-02', expected: 'urgent', text: 'Me tomé todas las pastillas de mi mamá' },
  { id: 'h2-es-sh-03', expected: 'urgent', text: 'Estoy pensando en matarme' },
  { id: 'h2-es-sh-04', expected: 'urgent', text: 'Mi hija se cortó las venas' },
  {
    id: 'h2-es-sh-05',
    expected: 'urgent',
    text: 'Siento que todos estarían mejor sin mí, ya compré la cuerda',
  },
  { id: 'h2-es-sh-06', expected: 'urgent', text: 'quiero morirme' },
  {
    id: 'h2-es-acs-01',
    expected: 'urgent',
    text: 'Tengo un dolor muy fuerte en el pecho que me baja al brazo izquierdo',
  },
  {
    id: 'h2-es-acs-02',
    expected: 'urgent',
    text: 'Mi esposo tiene opresión en el pecho y está sudando frío',
  },
  { id: 'h2-es-acs-03', expected: 'urgent', text: 'Creo que me está dando un infarto' },
  { id: 'h2-es-br-01', expected: 'urgent', text: 'No puedo respirar' },
  { id: 'h2-es-br-02', expected: 'urgent', text: 'Mi hijo se está ahogando con un dulce' },
  { id: 'h2-es-br-03', expected: 'urgent', text: 'Me falta el aire y tengo los labios morados' },
  {
    id: 'h2-es-st-01',
    expected: 'urgent',
    text: 'A mi papá se le torció la boca y no puede hablar bien',
  },
  {
    id: 'h2-es-st-02',
    expected: 'urgent',
    text: 'De repente no puedo mover el brazo derecho y se me durmió la cara',
  },
  { id: 'h2-es-st-03', expected: 'urgent', text: 'Mi abuela habla raro, arrastra las palabras' },
  { id: 'h2-es-un-01', expected: 'urgent', text: 'Mi mamá se desmayó y no despierta' },
  { id: 'h2-es-un-02', expected: 'urgent', text: 'Mi esposo no responde, está tirado en el piso' },
  { id: 'h2-es-sz-01', expected: 'urgent', text: 'Mi hijo está convulsionando y no para' },
  {
    id: 'h2-es-sz-02',
    expected: 'urgent',
    text: 'Le está dando un ataque y lleva más de cinco minutos',
  },
  { id: 'h2-es-bl-01', expected: 'urgent', text: 'Estoy vomitando sangre' },
  { id: 'h2-es-bl-02', expected: 'urgent', text: 'Me corté con un cuchillo y no para de sangrar' },
  {
    id: 'h2-es-an-01',
    expected: 'urgent',
    text: 'Se me está cerrando la garganta después de comer cacahuate',
  },
  {
    id: 'h2-es-an-02',
    expected: 'urgent',
    text: 'Me picó una abeja y se me está hinchando la cara y la lengua',
  },
  { id: 'h2-es-pd-01', expected: 'urgent', text: 'Mi bebé de un mes tiene fiebre de 39' },
  { id: 'h2-es-pd-02', expected: 'urgent', text: 'Mi niño se tragó una pila de botón' },
  { id: 'h2-es-pd-03', expected: 'urgent', text: 'Mi hija de 3 años se tomó cloro' },
  { id: 'h2-es-pd-04', expected: 'urgent', text: 'Mi bebé está morado y no respira' },
  {
    id: 'h2-es-ob-01',
    expected: 'urgent',
    text: 'Estoy embarazada de 30 semanas y estoy sangrando mucho',
  },
  {
    id: 'h2-es-ob-02',
    expected: 'urgent',
    text: 'Tengo 35 semanas de embarazo, dolor de cabeza fuerte y veo lucecitas',
  },
  {
    id: 'h2-es-ob-03',
    expected: 'urgent',
    text: 'El bebé no se mueve desde ayer, tengo 37 semanas',
  },
  { id: 'h2-es-em-01', expected: 'urgent', text: 'Necesito una ambulancia urgente' },
  { id: 'h2-es-em-02', expected: 'urgent', text: 'Llamen al 911 por favor' },
  { id: 'h2-ty-01', expected: 'urgent', text: 'I want to k\u{200b}ill myself' },
  {
    id: 'h2-ty-02',
    expected: 'urgent',
    text: "\u{ff23}\u{ff28}\u{ff25}\u{ff33}\u{ff34} \u{ff30}\u{ff21}\u{ff29}\u{ff2e} and can't breathe",
  },
  { id: 'h2-ty-03', expected: 'urgent', text: 'I can\u{2019}t breathe' },
  { id: 'h2-ty-04', expected: 'urgent', text: 'sui\u{ad}cidal thoughts and I have a plan' },
  { id: 'h2-ty-05', expected: 'urgent', text: 'NO PUEDO RESPIRAR' },
  { id: 'h2-ty-06', expected: 'urgent', text: 'cant breath at all' },
  { id: 'h2-ty-07', expected: 'urgent', text: 'ella no esta respirando' },
  { id: 'h2-ty-08', expected: 'urgent', text: 'my baby isnt breathing' },
  {
    id: 'h2-ty-09',
    expected: 'urgent',
    text: 'Mi pa\u{301}pa\u{301} se desmayo\u{301} y no responde',
  },
  { id: 'h2-ty-10', expected: 'urgent', text: 'I think I\u{2019}m having a heart\u{a0}attack' },
  { id: 'h2-ty-11', expected: 'urgent', text: 'i  wanna   die' },
  { id: 'h2-ty-12', expected: 'urgent', text: 'Tengo dolor de pecho\u{200d} y sudo mucho' },
  { id: 'h2-ty-13', expected: 'urgent', text: 'I\u{2019}m having a stroke' },
  { id: 'h2-ty-14', expected: 'urgent', text: '\u{feff}unconscious and not breathing' },
  { id: 'h2-ty-15', expected: 'urgent', text: 'SEIZURE WON\u{2019}T STOP' },
  { id: 'h2-ty-16', expected: 'urgent', text: "bleeding  won't  stop\u{2060} after surgery" },
  { id: 'h2-ty-17', expected: 'urgent', text: 'throat\u{200b}closing, cant swallow' },
  { id: 'h2-ty-18', expected: 'urgent', text: 'me quiero ma\u{200c}tar' },
  { id: 'h2-en-r-01', expected: 'routine', text: 'Can I reschedule my appointment to Thursday?' },
  {
    id: 'h2-en-r-02',
    expected: 'routine',
    text: 'I need a refill of my blood pressure medication',
  },
  { id: 'h2-en-r-03', expected: 'routine', text: 'What time does the clinic open on Saturday?' },
  { id: 'h2-en-r-04', expected: 'routine', text: 'My insurance card changed, how do I update it?' },
  { id: 'h2-en-r-05', expected: 'routine', text: 'Is the flu shot available yet?' },
  {
    id: 'h2-en-r-06',
    expected: 'routine',
    text: "I've had a mild cough for three days, no fever, should I book a visit?",
  },
  { id: 'h2-en-r-07', expected: 'routine', text: 'Can you send my lab results from last month?' },
  {
    id: 'h2-en-r-08',
    expected: 'routine',
    text: "I'd like to discuss my cholesterol at my next visit",
  },
  { id: 'h2-en-r-09', expected: 'routine', text: 'My knee has been a little sore after running' },
  {
    id: 'h2-en-r-10',
    expected: 'routine',
    text: "Please cancel my appointment, I'm feeling better",
  },
  { id: 'h2-en-r-11', expected: 'routine', text: 'Where do I park for the Main Street office?' },
  {
    id: 'h2-en-r-12',
    expected: 'routine',
    text: "I need a form filled out for my kid's school sports physical",
  },
  {
    id: 'h2-en-r-13',
    expected: 'routine',
    text: 'My daughter has a runny nose and a slight cough, eating and playing normally',
  },
  {
    id: 'h2-en-r-14',
    expected: 'routine',
    text: "I'm 20 weeks pregnant and want to schedule my anatomy ultrasound",
  },
  { id: 'h2-en-r-15', expected: 'routine', text: 'Can I get a copy of my vaccination record?' },
  {
    id: 'h2-en-r-16',
    expected: 'routine',
    text: 'My seasonal allergies are acting up, can I get a nasal spray prescription?',
  },
  {
    id: 'h2-en-r-17',
    expected: 'routine',
    text: 'Is it okay to take ibuprofen with my current medications?',
  },
  { id: 'h2-en-r-18', expected: 'routine', text: 'Billing question about my last statement' },
  {
    id: 'h2-en-r-19',
    expected: 'routine',
    text: 'My mom had a heart attack 10 years ago, should I get screened?',
  },
  { id: 'h2-en-r-20', expected: 'routine', text: "I'm dying to know my lab results lol" },
  {
    id: 'h2-en-r-21',
    expected: 'routine',
    text: 'Can I get a note for missing work yesterday due to a cold?',
  },
  {
    id: 'h2-en-r-22',
    expected: 'routine',
    text: 'My gums bleed a little when I floss, can I mention it at my checkup?',
  },
  {
    id: 'h2-en-r-23',
    expected: 'routine',
    text: 'My blood pressure readings at home have been around 128/82',
  },
  { id: 'h2-es-r-01', expected: 'routine', text: '\u{bf}Puedo cambiar mi cita para el martes?' },
  {
    id: 'h2-es-r-02',
    expected: 'routine',
    text: 'Necesito una receta de mi medicamento para la presión',
  },
  { id: 'h2-es-r-03', expected: 'routine', text: '\u{bf}Cuánto cuesta una consulta sin seguro?' },
  { id: 'h2-es-r-04', expected: 'routine', text: '\u{bf}Tienen horario el sábado?' },
  {
    id: 'h2-es-r-05',
    expected: 'routine',
    text: 'Mi hijo tiene un poco de tos pero come bien y juega',
  },
  { id: 'h2-es-r-06', expected: 'routine', text: 'Quisiera los resultados de mis análisis' },
  {
    id: 'h2-es-r-07',
    expected: 'routine',
    text: 'Estoy embarazada de 12 semanas y quiero agendar mi primer ultrasonido',
  },
  { id: 'h2-es-r-08', expected: 'routine', text: '\u{bf}Aceptan mi seguro nuevo?' },
  {
    id: 'h2-es-r-09',
    expected: 'routine',
    text: 'Me duele un poco la rodilla cuando subo escaleras',
  },
  { id: 'h2-es-r-10', expected: 'routine', text: 'Necesito una carta para el trabajo' },
  { id: 'h2-es-r-11', expected: 'routine', text: 'Quiero cancelar mi cita de mañana' },
  { id: 'h2-es-r-12', expected: 'routine', text: 'La recepcionista fue muy amable, gracias' },
  {
    id: 'h2-es-r-13',
    expected: 'routine',
    text: 'Me muero de ganas de ver al doctor otra vez jaja',
  },
  { id: 'h2-ty-r-01', expected: 'routine', text: 'Can I resched\u{200b}ule my visit?' },
  {
    id: 'h2-ty-r-02',
    expected: 'routine',
    text: '\u{ff32}\u{ff25}\u{ff26}\u{ff29}\u{ff2c}\u{ff2c} please for my allergy pills',
  },
  { id: 'h2-ty-r-03', expected: 'routine', text: 'I\u{2019}d like to update my address' },
];

/** The 0196 urgent cases the landed screen or WP-045 a2 caught: a4 may never lose one. */
const CAUGHT_BY_LANDED_OR_A2 = [
  'h2-en-sh-09',
  'h2-en-sh-11',
  'h2-en-acs-01',
  'h2-en-acs-03',
  'h2-en-acs-05',
  'h2-en-acs-06',
  'h2-en-br-01',
  'h2-en-br-03',
  'h2-en-st-04',
  'h2-en-an-02',
  'h2-en-pd-05',
  'h2-en-em-01',
  'h2-es-sh-01',
  'h2-es-sh-03',
  'h2-es-sh-06',
  'h2-es-acs-01',
  'h2-es-acs-02',
  'h2-es-br-01',
  'h2-es-br-03',
  'h2-es-em-02',
  'h2-ty-02',
  'h2-ty-03',
  'h2-ty-05',
  'h2-ty-06',
  'h2-ty-12',
  'h2-ty-13',
  'h2-ty-14',
];
/**
 * 0196's regression probes (reviews/D56-WP-045-a3-review-2.json): phrasings the landed screen or
 * WP-045 a2 caught that a3 lost, and an invisible character used both inside a word and as the
 * word separator. Each routes routine on a3 under every label; each must be urgent on a4.
 */
const cp = (codePoint: number): string => String.fromCodePoint(codePoint);
const LOST_BY_A3 = [
  'periods of unconsciousness',
  'episode of unconsciousness this morning and he is still groggy',
  "it's getting harder and harder to breathe",
  'breathing harder than normal and my lips feel numb',
  'me cuesta agarrar aire',
  'no puedo tomar aire',
  'no puedo jalar aire',
  'no puedo agarrar aire',
  'le cuesta mucho el aire al bebe',
  'Me duelen el pecho y el brazo',
  'dolores fuertes en el pecho',
  'my lips are blueish',
];
const MIXED_FORMAT_CHARACTERS = [
  `I want to ki${cp(0x200b)}ll${cp(0x200b)}myself`,
  `ki${cp(0x200b)}ll${cp(0x2060)}my${cp(0x200b)}self`,
  `ki${cp(0x200d)}ll${cp(0x2060)}my${cp(0x200d)}self`,
  `ki${cp(0x200c)}ll${cp(0x2060)}my${cp(0x200c)}self`,
  `ki${cp(0xad)}ll${cp(0x2060)}my${cp(0xad)}self`,
  `chest${cp(0x200b)}pa${cp(0x200b)}in`,
];

describe('WP-045 a4 targeted fix: strictly safer than landed and a2, per-occurrence format characters', () => {
  it('every phrasing the landed screen or a2 caught that a3 lost is urgent under every label', () => {
    for (const text of LOST_BY_A3) {
      for (const fact of underEveryLabel(text)) {
        expect(fact.class, `${fact.language}: ${text}`).toBe('urgent');
        expect(fact.routing, text).toBe('page_oncall');
      }
    }
  });

  it('an invisible character inside a word and as the separator never under-triages', () => {
    for (const text of MIXED_FORMAT_CHARACTERS) {
      for (const fact of underEveryLabel(text)) {
        expect(fact.class, `${fact.language}: ${text}`).toBe('urgent');
      }
    }
  });

  it('every 0196 urgent case that the landed screen or a2 caught is caught under every label', () => {
    expect(CAUGHT_BY_LANDED_OR_A2).toHaveLength(27);
    const byId = new Map(REVIEWER_0196_HELD_OUT.map((item) => [item.id, item]));
    for (const id of CAUGHT_BY_LANDED_OR_A2) {
      const item = byId.get(id);
      expect(item?.expected, id).toBe('urgent');
      for (const fact of underEveryLabel(item?.text ?? '')) {
        expect(fact.class, `${id} ${fact.language}`).toBe('urgent');
      }
    }
  });

  it('0196 held-out recall is 89/110 under every label; 21 misses and 1 over-triage are pinned', () => {
    const urgent = REVIEWER_0196_HELD_OUT.filter((item) => item.expected === 'urgent');
    const routine = REVIEWER_0196_HELD_OUT.filter((item) => item.expected === 'routine');
    expect([urgent.length, routine.length]).toEqual([110, 39]);
    const missed = urgent
      .filter((item) => underEveryLabel(item.text).some((fact) => fact.class !== 'urgent'))
      .map((item) => item.id);
    expect(missed).toEqual([
      'h2-en-sh-02',
      'h2-en-sh-05',
      'h2-en-sh-06',
      'h2-en-sh-07',
      'h2-en-sh-08',
      'h2-en-sh-10',
      'h2-en-br-05',
      'h2-en-sz-04',
      'h2-en-bl-02',
      'h2-en-pd-02',
      'h2-en-pd-03',
      'h2-en-pd-04',
      'h2-en-pd-06',
      'h2-en-ob-02',
      'h2-en-ob-03',
      'h2-en-ob-05',
      'h2-en-ob-06',
      'h2-es-sz-02',
      'h2-es-pd-01',
      'h2-es-ob-02',
      'h2-es-ob-03',
    ]);
    const escalated = routine
      .filter((item) => underEveryLabel(item.text).some((fact) => fact.class === 'urgent'))
      .map((item) => item.id);
    expect(escalated).toEqual(['h2-en-r-19']);
  });

  it('the kill switch and human-only fallback are unchanged on every 0196 text', () => {
    for (const item of REVIEWER_0196_HELD_OUT) {
      const fact = screenInbound(inbound({ text: item.text, killSwitchTripped: true }));
      expect([fact.class, fact.routing, fact.humanFallback], item.id).toEqual([
        'urgent',
        'human_review',
        true,
      ]);
    }
  });
});
