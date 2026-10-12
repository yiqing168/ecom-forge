import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';

import { cn } from '@/lib/cn';

const badgeVariants = cva(
  'inline-flex min-h-6 shrink-0 items-center whitespace-nowrap rounded px-2 py-0.5 text-xs font-semibold',
  {
    defaultVariants: { tone: 'neutral' },
    variants: {
      tone: {
        danger: 'bg-[var(--danger-soft)] text-[var(--danger)]',
        info: 'bg-[var(--primary-soft)] text-[var(--primary-strong)]',
        neutral: 'bg-[var(--soft)] text-[var(--neutral-foreground)]',
        success: 'bg-[var(--info-soft)] text-[var(--info-foreground)]',
        warning: 'bg-[var(--warning-soft)] text-[var(--warning-foreground)]',
      },
    },
  },
);

type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ className, tone }))} {...props} />;
}

const statusTone: Record<string, NonNullable<BadgeProps['tone']>> = {
  处理失败: 'danger',
  处理中: 'info',
  等待上传: 'warning',
  已完成: 'success',
  已拒绝: 'danger',
  已删除: 'neutral',
  已发布: 'success',
  已退款: 'neutral',
  已隔离: 'danger',
  隔离中: 'danger',
  失败: 'danger',
  等待中: 'warning',
  草稿: 'neutral',
  部分完成: 'warning',
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone[status] ?? 'neutral'}>{status}</Badge>;
}

export { badgeVariants };
