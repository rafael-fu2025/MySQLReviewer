import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../errors';

export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function parseBody<T>(schema: z.ZodType<T>, req: Request): T {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    throw new AppError('VALIDATION', 'Invalid request body.', 400, {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

export function parseQuery<T>(schema: z.ZodType<T>, req: Request): T {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    throw new AppError('VALIDATION', 'Invalid query parameters.', 400, {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

export function param(req: Request, name: string): string {
  const value = req.params[name];
  if (!value) throw new AppError('VALIDATION', `Missing route parameter: ${name}.`, 400);
  return value;
}

export function header(req: Request, name: string): string | null {
  const value = req.get(name);
  return value ? value.trim() : null;
}

export const idSchema = z.string().min(1).max(200);
export const databaseSchema = z.string().min(1).max(200);
export const sqlSchema = z.string().min(1).max(1_000_000);
