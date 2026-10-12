import { validatePublicText } from '@ecom-forge/agent';

export class AgentPublicDraft {
  private raw = '';
  private publishedCharacters = 0;
  private sequence = 0;
  private disabled = false;

  constructor(
    private readonly privateSkillContent: readonly string[],
    private readonly append: (sequence: number, delta: string) => Promise<boolean>,
    private readonly clear: () => Promise<void>,
  ) {}

  get published(): boolean {
    return this.sequence > 0;
  }

  async accept(text: string): Promise<void> {
    if (this.disabled || text === this.raw) return;
    if (!text.startsWith(this.raw) || [...text].length > 8_000) {
      await this.discard();
      return;
    }
    this.raw = text;
    const safe = validatePublicText(text, this.privateSkillContent);
    // Preview is deliberately stricter than the final response policy.
    if (
      !safe.ok ||
      /[\\`{}[\]<>]/u.test(text) ||
      /\bhttps?:|\b(?:api[_-]?key|secret|access[_-]?token|private[_-]?key)\b|-----BEGIN/i.test(text)
    ) {
      await this.discard();
      return;
    }
    const characters = [...safe.text];
    // Match the policy's whitespace normalization before deciding what can leave the buffer.
    let publishableEnd = characters.length;
    let retained = 0;
    let whitespace = false;
    while (publishableEnd > 0 && retained < 64) {
      const character = characters[--publishableEnd]!;
      const isWhitespace = /\s/u.test(character);
      if (!isWhitespace || !whitespace) retained += 1;
      whitespace = isWhitespace;
    }
    while (this.sequence < 64) {
      const chunkSize = this.sequence === 0 ? 16 : 128;
      if (publishableEnd - this.publishedCharacters < chunkSize) break;
      const delta = characters
        .slice(this.publishedCharacters, this.publishedCharacters + chunkSize)
        .join('');
      if (!(await this.append(this.sequence + 1, delta))) {
        this.disabled = true;
        return;
      }
      this.sequence += 1;
      this.publishedCharacters += chunkSize;
    }
  }

  async discard(): Promise<void> {
    this.disabled = true;
    if (this.sequence === 0) return;
    await this.clear();
    this.sequence = 0;
  }
}
