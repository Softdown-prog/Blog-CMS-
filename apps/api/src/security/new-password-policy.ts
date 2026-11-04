/** A future private adapter must compare against a breach/common-password corpus. */
export interface PasswordBlocklist {
  containsCandidate(candidate: string): Promise<boolean>;
}

export type PasswordPolicyResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: 'invalid' | 'too-short' | 'too-long' | 'blocked' }>;

const MIN_CODEPOINTS = 15;
const MAX_BYTES = 1024;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function hasInvalidSurrogates(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Intended for NEW credentials only; do not lock out existing accounts by
 * suddenly applying enrollment policy during password verification.
 * Does not normalize, trim or log a secret. Do not impose character classes.
 */
export class NewPasswordPolicy {
  constructor(private readonly blocklist: PasswordBlocklist) {}

  async evaluate(value: unknown): Promise<PasswordPolicyResult> {
    if (typeof value !== 'string' || value.length === 0 || UNSAFE.test(value)
      || hasInvalidSurrogates(value)) return { ok: false, reason: 'invalid' };
    if ([...value].length < MIN_CODEPOINTS) return { ok: false, reason: 'too-short' };
    if (Buffer.byteLength(value, 'utf8') > MAX_BYTES) {
      return { ok: false, reason: 'too-long' };
    }
    if (await this.blocklist.containsCandidate(value)) {
      return { ok: false, reason: 'blocked' };
    }
    return { ok: true };
  }
}

