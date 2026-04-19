import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { BodhiApiError, BodhiError } from '@bodhiapp/bodhi-js-react';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof BodhiApiError) return `API error (${err.status}): ${err.message}`;
  if (err instanceof BodhiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}
