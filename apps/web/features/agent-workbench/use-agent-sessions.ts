'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  archiveAgentSession,
  listAgentSessions,
  renameAgentSession,
  type SessionPreview,
} from '@/lib/agent-api';

type PendingMutation = { key: string; serialized: string };

export function useAgentSessions(enabled: boolean) {
  const [error, setError] = useState('');
  const [items, setItems] = useState<SessionPreview[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [mutationId, setMutationId] = useState<string | null>(null);
  const pendingRename = useRef<PendingMutation | null>(null);
  const pendingArchive = useRef<PendingMutation | null>(null);
  const listGeneration = useRef(0);

  useEffect(() => {
    const generation = ++listGeneration.current;
    setLoadingMore(false);
    if (!enabled) {
      setItems([]);
      setNextCursor(null);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      setError('');
      void listAgentSessions({ ...(query.trim() ? { query: query.trim() } : {}), limit: 20 })
        .then((result) => {
          if (!active || generation !== listGeneration.current) return;
          setItems(result.items);
          setNextCursor(result.next_cursor);
        })
        .catch((cause: unknown) => {
          if (!active || generation !== listGeneration.current) return;
          setError(cause instanceof Error ? cause.message : '会话加载失败，请重试');
        })
        .finally(() => {
          if (active && generation === listGeneration.current) setLoading(false);
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [enabled, query, reloadKey]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore || loading) return;
    const generation = listGeneration.current;
    setLoadingMore(true);
    setError('');
    try {
      const result = await listAgentSessions({
        cursor: nextCursor,
        ...(query.trim() ? { query: query.trim() } : {}),
        limit: 20,
      });
      if (generation !== listGeneration.current) return;
      setItems((current) => {
        const merged = new Map(current.map((item) => [item.id, item]));
        result.items.forEach((item) => merged.set(item.id, item));
        return [...merged.values()];
      });
      setNextCursor(result.next_cursor);
    } catch (cause) {
      if (generation !== listGeneration.current) return;
      setError(cause instanceof Error ? cause.message : '更多会话加载失败，请重试');
    } finally {
      if (generation === listGeneration.current) setLoadingMore(false);
    }
  }, [loading, loadingMore, nextCursor, query]);

  const rename = useCallback(async (session: SessionPreview, title: string) => {
    const serialized = JSON.stringify({
      operation: 'rename',
      session_id: session.id,
      revision: session.revision,
      title,
    });
    if (pendingRename.current?.serialized !== serialized) {
      pendingRename.current = {
        key: `agent-session-rename-${crypto.randomUUID()}`,
        serialized,
      };
    }
    const request = pendingRename.current;
    setMutationId(session.id);
    setError('');
    try {
      const result = await renameAgentSession(
        session.id,
        { revision: session.revision, title },
        request.key,
      );
      pendingRename.current = null;
      setItems((current) =>
        current.map((item) =>
          item.id === session.id
            ? {
                ...item,
                title: result.title,
                revision: result.revision,
                updated_at: result.updated_at,
              }
            : item,
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重命名失败，请重试');
      throw cause;
    } finally {
      setMutationId(null);
    }
  }, []);

  const archive = useCallback(async (session: SessionPreview) => {
    const serialized = JSON.stringify({
      operation: 'archive',
      session_id: session.id,
      revision: session.revision,
    });
    if (pendingArchive.current?.serialized !== serialized) {
      pendingArchive.current = {
        key: `agent-session-archive-${crypto.randomUUID()}`,
        serialized,
      };
    }
    const request = pendingArchive.current;
    setMutationId(session.id);
    setError('');
    try {
      await archiveAgentSession(session.id, session.revision, request.key);
      pendingArchive.current = null;
      setItems((current) => current.filter((item) => item.id !== session.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除会话失败，请重试');
      throw cause;
    } finally {
      setMutationId(null);
    }
  }, []);

  return {
    error,
    archive,
    items,
    loadMore,
    loading,
    loadingMore,
    mutationId,
    nextCursor,
    query,
    reload: useCallback(() => setReloadKey((current) => current + 1), []),
    rename,
    setQuery,
  };
}
