import { Shapes } from 'lucide-react';

import { cn } from '@/lib/cn';

export function BrandMark({ className }: { className?: string }) {
  return (
    <div
      aria-label="象塑"
      className={cn('grid size-10 shrink-0 place-items-center text-[var(--brand)]', className)}
      role="img"
    >
      <Shapes aria-hidden="true" className="size-full" strokeWidth={1.8} />
    </div>
  );
}
