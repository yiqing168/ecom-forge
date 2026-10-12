import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AssistantMarkdown } from './assistant-markdown';

afterEach(cleanup);

describe('AssistantMarkdown', () => {
  it('renders structured creative replies with GFM and accessible table scrolling', () => {
    const { container } = render(
      <AssistantMarkdown
        text={
          '## Direction\n\n**Light** and `texture`\n\n- First\n- Second\n\n> Quiet\n\n| A | B |\n| - | - |\n| Yes | No |'
        }
      />,
    );
    expect(screen.getByRole('heading', { name: 'Direction' })).toBeTruthy();
    expect(container.querySelector('strong')?.textContent).toBe('Light');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('region', { name: '表格' }).tabIndex).toBe(0);
    expect(screen.getByRole('table')).toBeTruthy();
  });
  it('never executes raw HTML, loads remote images or activates unsafe links', () => {
    const { container } = render(
      <AssistantMarkdown
        text={
          '<script>alert(1)</script>\n\n<img src="https://example.com/tracker">\n\n![remote](https://example.com/track)\n\n[unsafe](javascript:alert%281%29) [data](data:text/html,test) [relative](/api/v1/logout) [safe](https://example.com)'
        }
      />,
    );
    expect(container.querySelector('script, img, iframe')).toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link').getAttribute('rel')).toBe('noopener noreferrer');
  });
  it('handles incomplete streamed Markdown and uses the same rendering for the final reply', () => {
    const { container, rerender } = render(
      <AssistantMarkdown text={'## Direction\n\n**Soft'} streaming />,
    );
    expect(screen.getByRole('heading')).toBeTruthy();
    expect(container.textContent).toContain('Soft');
    const text = '## Direction\n\n**Soft light**\n\n```text\nlong line\n```';
    rerender(<AssistantMarkdown text={text} streaming />);
    const streamedBody = container.querySelector('[data-assistant-markdown]')!.innerHTML;
    rerender(<AssistantMarkdown text={text} />);
    expect(streamedBody).toContain(container.querySelector('[data-assistant-markdown]')!.innerHTML);
    expect(screen.getByLabelText('代码块').tabIndex).toBe(0);
  });
  it('allows empty drafts without inventing a reply', () => {
    const { container } = render(<AssistantMarkdown text="" />);
    expect(container.textContent).toBe('');
    expect(container.querySelector('p')).toBeNull();
  });

  it.each([
    '<svg onload="alert(1)"><a href="javascript:alert(1)">click</a></svg>',
    '[encoded](javascript&#58;alert%281%29) [data](data&#58;text/html,test)',
    '<iframe srcdoc=&lt;script&gt;alert(1)&lt;/script&gt;></iframe>',
    '[entity](&#' + '106;avascript:alert%281%29) [mixed](JaVaScRiPt:alert%281%29)',
    '[split](java\tscript:alert%281%29)',
    '[![nested](https://example.com/tracker)](javascript:alert%281%29)',
    '```html\n' + '<img src=x onerror=alert(1)>'.repeat(500),
  ])('keeps adversarial or incomplete Markdown inert', (text) => {
    const { container } = render(<AssistantMarkdown text={text} streaming />);
    expect(container.querySelector('script, svg, img, iframe, [onload], [onerror]')).toBeNull();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
});
