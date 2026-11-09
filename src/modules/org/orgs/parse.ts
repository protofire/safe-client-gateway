import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import type { z } from 'zod';

// ZodErrorFilter answers 502 (gateway upstream semantics); bad input is a 400
export function parse<T extends z.ZodType>(
  schema: T,
  input: unknown,
): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new BadRequestException(parsed.error.message);
  return parsed.data;
}

export type Actor = { userId: string; ip?: string; userAgent?: string };

export function actor(req: Request, userId: string): Actor {
  return { userId, ip: req.ip, userAgent: req.get('user-agent') };
}
