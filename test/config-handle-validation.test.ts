import { describe, expect, it } from 'vitest';

// Reach into the schema directly so we test it without polluting process.env.
// We re-construct the same schema fragment because the module is a singleton.
import { z } from 'zod';

const LabelerHandle = z
  .string()
  .optional()
  .superRefine((val, ctx) => {
    if (!val) return;
    if (val.startsWith('@')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `LABELER_HANDLE must not include the leading "@" (got "${val}" — use "${val.slice(1)}")`,
      });
      return;
    }
    if (!/^[a-z0-9._-]+\.[a-z0-9.-]+$/i.test(val)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `LABELER_HANDLE must be a domain-style handle like "facts.example.org" (got "${val}")`,
      });
    }
  });

describe('LABELER_HANDLE validation', () => {
  it('accepts a clean handle', () => {
    expect(LabelerHandle.parse('facts.example.org')).toBe('facts.example.org');
    expect(LabelerHandle.parse('facts.bsky.social')).toBe('facts.bsky.social');
    expect(LabelerHandle.parse('my-fact-bot.example.org')).toBe('my-fact-bot.example.org');
  });

  it('accepts undefined / empty', () => {
    expect(LabelerHandle.parse(undefined)).toBeUndefined();
  });

  it('rejects a leading @', () => {
    const r = LabelerHandle.safeParse('@facts.example.org');
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.message).toContain('must not include the leading "@"');
      expect(r.error.issues[0]!.message).toContain('"facts.example.org"');
    }
  });

  it('rejects a value without a dot (not domain-shaped)', () => {
    const r = LabelerHandle.safeParse('factbot');
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.message).toContain('domain-style handle');
    }
  });

  it('rejects whitespace and other unusual chars', () => {
    expect(LabelerHandle.safeParse('facts example.org').success).toBe(false);
    expect(LabelerHandle.safeParse('facts/example.org').success).toBe(false);
  });
});
