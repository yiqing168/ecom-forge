'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useRef, useState } from 'react';
import {
  Clock3,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Search,
  SquarePen,
  Trash2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import type { SessionPreview } from '@/lib/agent-api';

export type { SessionPreview } from '@/lib/agent-api';

const statusLabels = {
  completed: '已完成',
  failed: '需要处理',
  stopped: '已停止',
  thinking: '正在处理',
  waiting_for_you: '等你确认',
} as const;

function sessionGroup(updatedAt: string): '今天' | '昨天' | '更早' {
  const updated = new Date(updatedAt);
  const today = new Date();
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const time = updated.getTime();
  if (time >= startToday) return '今天';
  if (time >= startToday - 86_400_000) return '昨天';
  return '更早';
}

function sessionMeta(session: SessionPreview): string {
  return session.last_turn_status
    ? statusLabels[session.last_turn_status]
    : session.last_message_preview || '尚未发送内容';
}

function SessionItems({
  activeId,
  error,
  loading,
  loadingMore,
  nextCursor,
  onLoadMore,
  onArchive,
  onRename,
  onSelect,
  mutationId,
  sessions,
}: {
  activeId?: string | undefined;
  error: string;
  loading: boolean;
  loadingMore: boolean;
  nextCursor: string | null;
  onLoadMore: () => void;
  onArchive: (session: SessionPreview) => Promise<void>;
  onRename: (session: SessionPreview, title: string) => Promise<void>;
  onSelect: (session: SessionPreview) => void;
  mutationId: string | null;
  sessions: SessionPreview[];
}) {
  if (loading && sessions.length === 0) {
    return (
      <p className="px-2 py-8 text-center text-sm text-[var(--muted-foreground)]">加载会话中…</p>
    );
  }
  if (error && sessions.length === 0) {
    return <p className="px-2 py-8 text-center text-sm text-[var(--danger)]">{error}</p>;
  }
  if (sessions.length === 0) {
    return <p className="px-2 py-8 text-center text-sm text-[var(--muted-foreground)]">暂无会话</p>;
  }
  return (
    <>
      {(['今天', '昨天', '更早'] as const).map((group) => {
        const groupItems = sessions.filter((session) => sessionGroup(session.updated_at) === group);
        if (groupItems.length === 0) return null;
        return (
          <section className="mt-3" key={group}>
            <h3 className="mb-1 flex items-center gap-1.5 px-2 text-xs font-semibold text-[var(--subtle-foreground)]">
              <Clock3 size={13} />
              {group}
            </h3>
            <div>
              {groupItems.map((session) => (
                <SessionRow
                  active={activeId === session.id}
                  disabled={mutationId === session.id}
                  key={session.id}
                  onArchive={onArchive}
                  onRename={onRename}
                  onSelect={onSelect}
                  session={session}
                />
              ))}
            </div>
          </section>
        );
      })}
      {error ? <p className="px-2 py-3 text-sm text-[var(--danger)]">{error}</p> : null}
      {nextCursor ? (
        <Button
          className="mt-3 w-full"
          disabled={loading || loadingMore}
          onClick={onLoadMore}
          variant="ghost"
        >
          {loadingMore ? '加载中…' : '加载更多'}
        </Button>
      ) : null}
    </>
  );
}

function SessionRow({
  active,
  disabled,
  onArchive,
  onRename,
  onSelect,
  session,
}: {
  active: boolean;
  disabled: boolean;
  onArchive: (session: SessionPreview) => Promise<void>;
  onRename: (session: SessionPreview, title: string) => Promise<void>;
  onSelect: (session: SessionPreview) => void;
  session: SessionPreview;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(session.title);
  if (editing) {
    return (
      <form
        className="rounded-md bg-[var(--soft)] p-2"
        onSubmit={(event) => {
          event.preventDefault();
          const normalized = title.normalize('NFKC').trim();
          if (!normalized || normalized === session.title) {
            setEditing(false);
            return;
          }
          void onRename(session, normalized)
            .then(() => setEditing(false))
            .catch(() => undefined);
        }}
      >
        <Input
          aria-label="会话名称"
          autoFocus
          maxLength={120}
          onChange={(event) => setTitle(event.target.value)}
          value={title}
        />
        <div className="mt-2 flex justify-end gap-1">
          <Button
            onClick={() => {
              setTitle(session.title);
              setEditing(false);
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            取消
          </Button>
          <Button disabled={disabled} size="sm" type="submit">
            保存
          </Button>
        </div>
      </form>
    );
  }
  return (
    <div
      className={cn(
        'group flex items-stretch rounded-md border border-transparent transition-colors hover:bg-[var(--soft)]',
        active &&
          'border-[var(--border-strong)] bg-[var(--primary-soft)] hover:bg-[var(--primary-soft)]',
      )}
    >
      <button
        aria-current={active ? 'page' : undefined}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-md px-2 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
        onClick={() => onSelect(session)}
        type="button"
      >
        <MessageSquareText
          aria-hidden="true"
          className={cn(
            'mt-0.5 shrink-0',
            active ? 'text-[var(--brand)]' : 'text-[var(--muted-foreground)]',
          )}
          size={17}
        />
        <span className="min-w-0">
          <span
            className={cn(
              'block truncate text-sm font-semibold',
              active && 'text-[var(--primary-strong)]',
            )}
          >
            {session.title}
          </span>
          <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
            {sessionMeta(session)}
          </span>
        </span>
      </button>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button
            aria-label={`管理会话：${session.title}`}
            className="my-2 grid size-9 shrink-0 place-items-center rounded-md text-[var(--muted-foreground)] opacity-0 outline-none hover:bg-white group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
            disabled={disabled}
            type="button"
          >
            <MoreHorizontal aria-hidden="true" size={16} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            className="z-[90] min-w-36 rounded-md border border-[var(--border)] bg-white p-1.5 shadow-[var(--shadow-md)]"
            sideOffset={4}
          >
            <DropdownMenu.Item
              className="flex min-h-10 cursor-pointer items-center gap-2 rounded px-2.5 text-sm outline-none focus:bg-[var(--soft)]"
              onSelect={() => setEditing(true)}
            >
              <Pencil aria-hidden="true" size={15} />
              重命名
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="flex min-h-10 cursor-pointer items-center gap-2 rounded px-2.5 text-sm text-[var(--danger)] outline-none focus:bg-[var(--soft)]"
              onSelect={() => void onArchive(session).catch(() => undefined)}
            >
              <Trash2 aria-hidden="true" size={15} />
              删除会话
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

function SessionSearch({
  onQueryChange,
  query,
}: {
  onQueryChange: (query: string) => void;
  query: string;
}) {
  return (
    <label className="mt-3 flex min-h-11 items-center gap-2 rounded-md border border-transparent bg-[var(--soft)] px-3 text-sm transition-colors focus-within:border-[var(--brand)] focus-within:bg-[var(--surface)] focus-within:ring-2 focus-within:ring-[var(--focus-soft)]">
      <span className="sr-only">搜索会话</span>
      <Search aria-hidden="true" className="shrink-0 text-[var(--muted-foreground)]" size={16} />
      <Input
        className="h-10 min-w-0 border-0 bg-transparent px-0 focus:border-transparent focus:ring-0"
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="搜索会话"
        value={query}
      />
    </label>
  );
}

export function SessionSidebar({
  activeId,
  error,
  loading,
  loadingMore,
  nextCursor,
  onNewSession,
  onLoadMore,
  onArchive,
  onRename,
  onQueryChange,
  onSelect,
  query,
  sessions,
  mutationId,
}: {
  activeId?: string | undefined;
  error: string;
  loading: boolean;
  loadingMore: boolean;
  nextCursor: string | null;
  onNewSession: () => void;
  onLoadMore: () => void;
  onArchive: (session: SessionPreview) => Promise<void>;
  onRename: (session: SessionPreview, title: string) => Promise<void>;
  onQueryChange: (query: string) => void;
  onSelect: (session: SessionPreview) => void;
  query: string;
  sessions: SessionPreview[];
  mutationId: string | null;
}) {
  return (
    <aside
      aria-label="会话栏"
      className="fixed inset-y-0 left-[128px] z-30 hidden w-[280px] flex-col border-r border-[var(--border)] bg-white lg:flex"
    >
      <div className="flex h-16 items-center justify-between border-b border-[var(--border)] px-4">
        <p className="text-[15px] font-bold">生成</p>
      </div>
      <div className="p-3">
        <button
          aria-current={activeId === 'new' ? 'page' : undefined}
          className="flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-md px-3 text-sm font-semibold outline-none hover:bg-[var(--soft)] focus-visible:ring-2 focus-visible:ring-[var(--focus)] aria-[current=page]:bg-[var(--soft)]"
          onClick={onNewSession}
          type="button"
        >
          <SquarePen aria-hidden="true" size={17} />
          新对话
        </button>
        <SessionSearch onQueryChange={onQueryChange} query={query} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-5">
        <SessionItems
          activeId={activeId}
          error={error}
          loading={loading}
          loadingMore={loadingMore}
          nextCursor={nextCursor}
          onLoadMore={onLoadMore}
          onArchive={onArchive}
          onRename={onRename}
          onSelect={onSelect}
          mutationId={mutationId}
          sessions={sessions}
        />
      </div>
    </aside>
  );
}

export function SessionHistory({
  activeId,
  error,
  loading,
  loadingMore,
  nextCursor,
  onLoadMore,
  onArchive,
  onRename,
  onNewSession,
  onOpenChange,
  onQueryChange,
  onSelect,
  open,
  query,
  sessions,
  mutationId,
}: {
  activeId?: string | undefined;
  error: string;
  loading: boolean;
  loadingMore: boolean;
  nextCursor: string | null;
  onLoadMore: () => void;
  onArchive: (session: SessionPreview) => Promise<void>;
  onRename: (session: SessionPreview, title: string) => Promise<void>;
  onNewSession: () => void;
  onOpenChange: (open: boolean) => void;
  onQueryChange: (query: string) => void;
  onSelect: (session: SessionPreview) => void;
  open: boolean;
  query: string;
  sessions: SessionPreview[];
  mutationId: string | null;
}) {
  const scrollTop = useRef(0);
  return (
    <Dialog modal={false} onOpenChange={onOpenChange} open={open}>
      <DialogContent className="!left-0 !top-16 !flex !h-[calc(100dvh-64px)] !w-[min(340px,calc(100vw-24px))] !translate-x-0 !translate-y-0 !flex-col !rounded-none !border-y-0 !border-l-0 !p-0 lg:!left-[128px]">
        <div className="border-b border-[var(--border)] p-4 pr-16">
          <DialogTitle className="text-lg font-bold">生成</DialogTitle>
          <DialogDescription className="mt-1 text-sm text-[var(--muted-foreground)]">
            继续之前的对话和结果
          </DialogDescription>
        </div>
        <div className="p-3">
          <Button
            className="w-full"
            onClick={() => {
              onNewSession();
              onOpenChange(false);
            }}
            variant="inverse"
          >
            <SquarePen aria-hidden="true" size={17} />
            新建会话
          </Button>
          <SessionSearch onQueryChange={onQueryChange} query={query} />
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto px-3 pb-5"
          onScroll={(event) => {
            scrollTop.current = event.currentTarget.scrollTop;
          }}
          ref={(element) => {
            if (element) element.scrollTop = scrollTop.current;
          }}
        >
          <SessionItems
            activeId={activeId}
            error={error}
            loading={loading}
            loadingMore={loadingMore}
            nextCursor={nextCursor}
            onLoadMore={onLoadMore}
            onArchive={onArchive}
            onRename={onRename}
            onSelect={(session) => {
              onSelect(session);
              onOpenChange(false);
            }}
            mutationId={mutationId}
            sessions={sessions}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
