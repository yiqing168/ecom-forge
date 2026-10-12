'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=closed]:animate-[fade-out_100ms_ease-in] data-[state=open]:animate-[fade-in_120ms_ease-out]" />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[min(calc(100vw-32px),480px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-black/8 bg-white p-7 shadow-[0_24px_80px_rgba(24,28,32,0.18)] outline-none data-[state=closed]:animate-[fade-out_100ms_ease-in] data-[state=open]:animate-[fade-in_120ms_ease-out]',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          aria-label="关闭"
          className="absolute right-4 top-4 inline-flex size-10 cursor-pointer items-center justify-center rounded-md text-[var(--muted-foreground)] outline-none hover:bg-[var(--soft)] hover:text-[var(--foreground)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
        >
          <X aria-hidden="true" size={18} strokeWidth={1.8} />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
