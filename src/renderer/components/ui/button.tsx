import { Button as BaseButton } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

const styles = cva(
  'inline-flex min-h-9 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400 disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-violet-500 text-white hover:bg-violet-400',
        secondary: 'border border-zinc-700 bg-zinc-800 text-zinc-100 hover:bg-zinc-700',
        ghost: 'text-zinc-300 hover:bg-zinc-800',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export function Button({
  className,
  variant,
  ...props
}: ComponentProps<typeof BaseButton> & VariantProps<typeof styles>) {
  return <BaseButton className={cn(styles({ variant }), className)} {...props} />;
}
