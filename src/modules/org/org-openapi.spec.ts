import type { OpenAPIObject } from '@nestjs/swagger';
import { buildOrgOpenApiDocument } from '../../../scripts/org-openapi';

type Schema = {
  type?: string;
  format?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
};
type Operation = {
  requestBody?: {
    content: Record<string, { schema: Schema }>;
  };
};

// Bodiless on purpose: nothing is read from the request body.
const BODILESS = new Set([
  'POST /v1/orgs/auth/logout',
  'POST /v1/orgs/auth/totp/enroll',
  'POST /v1/orgs/{orgId}/members/leave',
  'POST /v1/orgs/{orgId}/restore',
  'POST /v1/orgs/{orgId}/members/{memberId}/invite/renew',
  'POST /v1/orgs/{orgId}/members/{memberId}/factors/reset',
  'POST /v1/orgs/{invitedOrgId}/members/accept',
  'POST /v1/orgs/{invitedOrgId}/members/decline',
  'POST /v1/orgs/{orgId}/contact-requests/{requestId}/approve',
  'POST /v1/orgs/{orgId}/contact-requests/{requestId}/reject',
  'POST /v1/orgs/{orgId}/payout-runs/{runId}/proposal-attempts/{attemptId}/release',
]);

describe('org OpenAPI document', () => {
  let doc: OpenAPIObject;
  const op = (method: string, path: string): Operation =>
    (doc.paths[path] as Record<string, Operation>)[method];

  beforeAll(async () => {
    doc = await buildOrgOpenApiDocument();
  });

  it('describes a request body for every POST, PUT and PATCH route except the listed bodiless ones', () => {
    const missing = Object.entries(doc.paths).flatMap(([path, item]) =>
      Object.entries(item as Record<string, Operation>)
        .filter(([method]) => ['post', 'put', 'patch'].includes(method))
        .filter(
          ([method, o]) =>
            !o.requestBody && !BODILESS.has(`${method.toUpperCase()} ${path}`),
        )
        .map(([method]) => `${method.toUpperCase()} ${path}`),
    );
    expect(missing).toEqual([]);
    for (const key of BODILESS) {
      const [method, path] = key.split(' ');
      expect(op(method.toLowerCase(), path)).toBeDefined();
      expect(op(method.toLowerCase(), path).requestBody).toBeUndefined();
    }
  });

  it('describes bodies for claim, PATCH payout run, create policy and invitation create', () => {
    for (const [method, path] of [
      ['post', '/v1/orgs/{orgId}/payout-runs/{runId}/proposal-attempts'],
      ['patch', '/v1/orgs/{orgId}/payout-runs/{runId}'],
      ['post', '/v1/orgs/{orgId}/policies'],
      ['post', '/v1/orgs/{orgId}/members/invite'],
    ]) {
      expect(
        op(method, path).requestBody?.content['application/json'].schema
          .properties,
      ).toBeDefined();
    }
  });

  it('marks payout row amount as a string, never a number', () => {
    const schema = op('post', '/v1/orgs/{orgId}/payout-runs').requestBody
      ?.content['application/json'].schema;
    expect(schema?.properties?.rows?.items?.properties?.amount?.type).toBe(
      'string',
    );
  });

  it('describes multipart upload and query parameters', () => {
    expect(
      op('post', '/v1/orgs/{orgId}/payout-runs/import').requestBody?.content[
        'multipart/form-data'
      ]?.schema.properties?.file?.format,
    ).toBe('binary');
    const params = (
      doc.paths['/v1/orgs/{orgId}/transactions.csv'] as {
        get: { parameters: Array<{ name: string; in: string }> };
      }
    ).get.parameters;
    expect(params.filter((p) => p.in === 'query').map((p) => p.name)).toEqual(
      expect.arrayContaining(['executedFrom', 'executedTo']),
    );
  });
});
