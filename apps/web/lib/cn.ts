/** Tiny classnames joiner — shadcn-style `cn` without the clsx dependency. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ');
}
