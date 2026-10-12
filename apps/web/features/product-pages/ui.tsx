'use client';

import { Search, SlidersHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';

export function PageHeader({
  actions,
  description,
  title,
}: {
  actions?: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <header className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-[28px] font-bold leading-tight sm:text-[32px]">{title}</h1>
        <p className="mt-2 text-sm text-[var(--muted-foreground)] sm:text-[15px]">{description}</p>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function SearchBar({
  onChange,
  placeholder = '搜索',
  value,
}: {
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  return (
    <label className="relative block min-w-0 flex-1 sm:max-w-sm">
      <span className="sr-only">{placeholder}</span>
      <Search
        aria-hidden="true"
        className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--subtle-foreground)]"
        size={17}
      />
      <Input
        className="pl-10"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
    </label>
  );
}

export function FilterBar({
  children,
  onSearch,
  search,
  searchPlaceholder,
}: {
  children?: ReactNode;
  onSearch: (value: string) => void;
  search: string;
  searchPlaceholder?: string;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-2 border-y border-[var(--border)] py-3">
      <SearchBar
        onChange={onSearch}
        {...(searchPlaceholder === undefined ? {} : { placeholder: searchPlaceholder })}
        value={search}
      />
      <div className="ml-auto flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

export function FilterButton({ children }: { children: ReactNode }) {
  return (
    <Button type="button" variant="outline">
      <SlidersHorizontal aria-hidden="true" size={15} />
      {children}
    </Button>
  );
}

export { StatusBadge };

export function MetricStrip({ items }: { items: Array<{ label: string; value: string }> }) {
  return (
    <div className="mb-6 grid border-y border-[var(--border)] bg-white sm:grid-cols-2 lg:grid-cols-4">
      {items.map((item, index) => (
        <div
          className={cn(
            'px-5 py-4',
            index > 0 && 'border-t border-[var(--border)] sm:border-l sm:border-t-0',
          )}
          key={item.label}
        >
          <p className="text-xs text-[var(--muted-foreground)]">{item.label}</p>
          <p className="mt-1 text-xl font-bold tabular-nums">{item.value}</p>
        </div>
      ))}
    </div>
  );
}
