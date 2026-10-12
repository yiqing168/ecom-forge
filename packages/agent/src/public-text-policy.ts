import { z } from 'zod';

export const publicTextPolicyRuleSchema = z.enum([
  'invalid_unicode',
  'control_character',
  'secret_pattern',
  'signed_url',
  'internal_field',
  'system_prompt_fragment',
  'private_skill_overlap',
]);

export type PublicTextPolicyRule = z.infer<typeof publicTextPolicyRuleSchema>;

export type PublicTextPolicyResult =
  { ok: true; text: string } | { ok: false; rule: PublicTextPolicyRule };

const secretPatterns = [
  /\b(?:api[_-]?key|secret|access[_-]?token|private[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
const signedUrlPattern = /https?:\/\/\S+[?&](?:x-amz-signature|signature|sig|token|credential)=/i;
const internalFieldPattern =
  /\b(?:tool_name|args_hash|tool_fingerprint|operation_key|processing_owner|system_prompt|chain_of_thought)\b/i;
const systemPromptPattern =
  /(?:reveal|print|return|expose|ignore).{0,40}(?:system prompt|developer message|hidden context)/i;
const privateOverlapWindow = 16;
const privateOverlapIndexes = new WeakMap<readonly string[], ReadonlySet<string>>();

export function validatePublicText(
  rawText: string,
  privateSkillContent: readonly string[],
): PublicTextPolicyResult {
  const text = rawText.normalize('NFC');
  if (hasLoneSurrogate(text)) return { ok: false, rule: 'invalid_unicode' };
  if (hasDisallowedControl(text)) return { ok: false, rule: 'control_character' };
  if (secretPatterns.some((pattern) => pattern.test(text))) {
    return { ok: false, rule: 'secret_pattern' };
  }
  if (signedUrlPattern.test(text)) return { ok: false, rule: 'signed_url' };
  if (internalFieldPattern.test(text)) return { ok: false, rule: 'internal_field' };
  if (systemPromptPattern.test(text)) return { ok: false, rule: 'system_prompt_fragment' };
  if (hasPrivateOverlap(text, privateSkillContent)) {
    return { ok: false, rule: 'private_skill_overlap' };
  }
  return { ok: true, text };
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function hasDisallowedControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159)) {
      return true;
    }
  }
  return false;
}

function hasPrivateOverlap(text: string, privateSkillContent: readonly string[]): boolean {
  if (privateSkillContent.length === 0) return false;
  const characters = Array.from(normalizeForOverlap(text));
  if (characters.length < privateOverlapWindow) return false;
  let index = privateOverlapIndexes.get(privateSkillContent);
  if (!index) {
    const windows = new Set<string>();
    for (const content of privateSkillContent) {
      const source = Array.from(normalizeForOverlap(content));
      for (let offset = 0; offset + privateOverlapWindow <= source.length; offset += 1) {
        windows.add(source.slice(offset, offset + privateOverlapWindow).join(''));
      }
    }
    index = windows;
    privateOverlapIndexes.set(privateSkillContent, index);
  }
  for (let offset = 0; offset + privateOverlapWindow <= characters.length; offset += 1) {
    if (index.has(characters.slice(offset, offset + privateOverlapWindow).join(''))) return true;
  }
  return false;
}

function normalizeForOverlap(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}
