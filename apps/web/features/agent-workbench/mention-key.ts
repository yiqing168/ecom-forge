export function attachmentMentionKey(label: string): string {
  const normalized = label
    .normalize('NFKC')
    .split('')
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const safeLabel = Array.from(normalized || '附件')
    .slice(0, 119)
    .join('');
  return `@${safeLabel}`;
}
