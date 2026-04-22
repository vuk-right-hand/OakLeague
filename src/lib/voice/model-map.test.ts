// Parity smoke test for the model-map module. Ensures ENUM_TO_WIRE /
// WIRE_TO_ENUM are self-inverse and that isAllowedWireModel lines up with
// the documented PG `voice_model_wire_value` values (R4-M3).
//
// Live DB parity check (queries information_schema + voice_model_wire_value)
// lives in the optional `npm run test:db-parity` gate; this unit test
// protects the TS table from drift inside a single commit.

import { describe, expect, it } from 'vitest';
import {
  ENUM_TO_WIRE,
  VOICE_MODEL_ENUMS,
  WIRE_TO_ENUM,
  isAllowedWireModel,
} from './model-map';

// Mirror of voice_model_wire_value() from migration 20260502000001.
// If this snapshot ever diverges from the migration it's a bug — fix the
// migration, then update this constant. The reverse direction (updating
// only the TS side) is how we drifted in Spike A.
const PG_WIRE_VALUES: Record<string, string> = {
  gemini_3_1_flash_live_preview: 'gemini-3.1-flash-live-preview',
  gemini_live_2_5_flash_native_audio: 'gemini-2.5-flash-native-audio-preview-12-2025',
};

describe('voice model-map', () => {
  it('enum → wire matches the migration snapshot', () => {
    for (const e of VOICE_MODEL_ENUMS) {
      expect(ENUM_TO_WIRE[e]).toBe(PG_WIRE_VALUES[e]);
    }
  });

  it('round-trips in both directions', () => {
    for (const e of VOICE_MODEL_ENUMS) {
      const wire = ENUM_TO_WIRE[e];
      expect(WIRE_TO_ENUM[wire]).toBe(e);
    }
  });

  it('isAllowedWireModel accepts every canonical wire form', () => {
    for (const e of VOICE_MODEL_ENUMS) {
      expect(isAllowedWireModel(ENUM_TO_WIRE[e])).toBe(true);
    }
  });

  it('isAllowedWireModel rejects uppercased / aliased forms', () => {
    expect(isAllowedWireModel('Gemini-3.1-Flash-Live-Preview')).toBe(false);
    expect(isAllowedWireModel('gemini-3.1-flash-live')).toBe(false);
    expect(isAllowedWireModel('gemini-live-2.5-flash-native-audio')).toBe(false);
    expect(isAllowedWireModel('')).toBe(false);
  });

  it('contains exactly the enums the PG snapshot declares', () => {
    expect(Object.keys(ENUM_TO_WIRE).sort()).toEqual(Object.keys(PG_WIRE_VALUES).sort());
  });
});
