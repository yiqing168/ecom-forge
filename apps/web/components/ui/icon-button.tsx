import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> & {
  'aria-label': string;
  icon: ReactNode;
  tooltip?: string;
  variant?: 'danger' | 'ghost' | 'inverse' | 'outline' | 'primary' | 'secondary';
};

export function IconButton({
  'aria-label': ariaLabel,
  icon,
  tooltip = ariaLabel,
  variant = 'ghost',
  ...props
}: IconButtonProps) {
  return (
    <Tooltip label={tooltip}>
      <Button aria-label={ariaLabel} size="icon" variant={variant} {...props}>
        {icon}
      </Button>
    </Tooltip>
  );
}
