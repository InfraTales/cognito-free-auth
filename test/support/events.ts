import type { APIGatewayProxyEventV2 } from 'aws-lambda';

/** A Lambda function URL event (payload format 2.0) with only the fields the API reads. */
export function request(method: string, path: string, token?: string, body?: unknown): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { method, path } } as APIGatewayProxyEventV2['requestContext'],
  };
}
