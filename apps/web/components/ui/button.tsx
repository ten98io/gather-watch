import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

const variantClasses: Record<ButtonVariant, string> = {
  // Aurora gradient is reserved for primary actions (DESIGN.md §2, §8).
  primary:
    'aurora-gradient text-accent-ink font-semibold hover:shadow-glow hover:brightness-110 active:brightness-95',
  secondary:
    'glass-raised text-hi hover:bg-raised hover:shadow-glow active:brightness-95',
  destructive:
    'bg-danger text-accent-ink font-semibold hover:brightness-110 active:brightness-95',
  ghost: 'text-mid hover:text-hi hover:bg-glass active:brightness-95',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-sm rounded-ctl gap-1.5',
  md: 'h-11 px-4 text-sm rounded-ctl gap-2',
  lg: 'h-12 px-6 text-base rounded-card gap-2',
  icon: 'h-11 w-11 rounded-ctl',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/** Buttons (DESIGN.md §8): primary = aurora gradient, secondary = glass,
 *  destructive = --danger. Hit targets ≥ 44px except `sm`. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className, type, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap transition-all duration-200 ease-spring',
        'disabled:pointer-events-none disabled:opacity-50',
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    />
  );
});
