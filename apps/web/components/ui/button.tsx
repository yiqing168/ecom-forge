import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';

import { cn } from '@/lib/cn';

const buttonVariants = cva(
  'inline-flex min-h-11 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-[7px] px-4 text-sm font-semibold outline-none transition-[background-color,border-color,color,box-shadow,transform] duration-200 focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-45 active:translate-y-px',
  {
    defaultVariants: {
      size: 'default',
      variant: 'primary',
    },
    variants: {
      size: {
        default: 'h-11',
        icon: 'size-11 px-0',
        lg: 'h-12 px-5 text-[15px]',
        sm: 'min-h-9 h-9 px-3 text-[13px]',
      },
      variant: {
        danger: 'bg-[var(--danger)] !text-white hover:bg-[var(--danger-hover)]',
        ghost:
          'bg-transparent text-[var(--muted-foreground)] hover:bg-[var(--soft)] hover:text-[var(--foreground)]',
        outline:
          'border border-[var(--border-strong)] bg-white text-[var(--foreground)] hover:border-[var(--primary)] hover:bg-[var(--primary-soft)]',
        inverse: 'bg-[var(--inverse)] !text-white shadow-sm hover:bg-[var(--inverse-hover)]',
        primary:
          'bg-[var(--primary)] !text-white shadow-[0_1px_1px_rgba(0,0,0,0.08)] hover:bg-[var(--primary-hover)]',
        secondary: 'bg-[var(--soft)] text-[var(--foreground)] hover:bg-[var(--soft-strong)]',
      },
    },
  },
);

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

export function Button({ asChild = false, className, size, variant, ...props }: ButtonProps) {
  const Component = asChild ? Slot : 'button';

  return <Component className={cn(buttonVariants({ className, size, variant }))} {...props} />;
}

export { buttonVariants };
