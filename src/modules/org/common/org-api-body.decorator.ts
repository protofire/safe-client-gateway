import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiQuery } from '@nestjs/swagger';
import { z } from 'zod';

type Json = Record<string, unknown>;
type Props = { properties?: Record<string, Json>; required?: Array<string> };

/** Documentation only: the zod schema stays the runtime validator. */
function toJson(schema: z.ZodType): Json {
  const json = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  }) as Json;
  delete json.$schema;
  return json;
}

export const OrgApiBody = (schema: z.ZodType): MethodDecorator =>
  ApiBody({ schema: toJson(schema) });

/** One `query` parameter per property of the object schema. */
export function OrgApiQuery(schema: z.ZodType): MethodDecorator {
  const { properties = {}, required = [] } = toJson(schema) as Props;
  return applyDecorators(
    ...Object.entries(properties).map(([name, property]) =>
      ApiQuery({ name, required: required.includes(name), schema: property }),
    ),
  );
}

/** multipart/form-data with a `file` part, plus the text fields of `fields`. */
export function OrgApiFile(fields?: z.ZodType): MethodDecorator {
  const { properties = {}, required = [] } = fields
    ? (toJson(fields) as Props)
    : {};
  return applyDecorators(
    ApiConsumes('multipart/form-data'),
    ApiBody({
      schema: {
        type: 'object',
        properties: {
          file: { type: 'string', format: 'binary' },
          ...properties,
        },
        required: ['file', ...required],
      },
    }),
  );
}
