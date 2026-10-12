'use client';

import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import styles from './assistant-markdown.module.css';

const plugins = [remarkGfm];
const components: Components = {
  a: ({ children, href }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // Conversation attachments own image authorization and loading.
  img: () => null,
  table: ({ children }) => (
    <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="表格">
      <table>{children}</table>
    </div>
  ),
  pre: ({ children }) => (
    <pre tabIndex={0} aria-label="代码块">
      {children}
    </pre>
  ),
};

function safeLink(url: string): string {
  try {
    const parsed = new URL(url);
    return ['https:', 'http:', 'mailto:'].includes(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
}

export const AssistantMarkdown = memo(function AssistantMarkdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  return (
    <div className={styles.markdown} data-assistant-markdown="">
      <ReactMarkdown
        remarkPlugins={plugins}
        components={components}
        skipHtml
        urlTransform={safeLink}
      >
        {text}
      </ReactMarkdown>
      {streaming ? <span className={styles.cursor} aria-hidden="true" /> : null}
    </div>
  );
});
