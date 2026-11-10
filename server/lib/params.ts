import type { Request } from "express";

/**
 * Express 5 route params can be `string | string[]` (repeated segments via
 * path-to-regexp v8). Route handlers here never use repeated params, so this
 * normalizes to the first string value and gives TS a plain string to reason
 * about instead of scattering casts.
 */
export function paramOf(req: Request, name: string): string {
  const value = req.params[name];
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}
