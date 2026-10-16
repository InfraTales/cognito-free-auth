/**
 * Checks a deployed stack end to end:
 *   npm run smoke            (uses your AWS credentials and CDK_DEFAULT_REGION / AWS_REGION)
 *
 * 1. The API refuses requests with no token and with a junk token.
 * 2. A throwaway user signs in with USER_AUTH, sets up TOTP MFA (required by the pool) and gets tokens.
 * 3. The access token works on /me and /notes. The ID token is refused.
 * 4. The user is deleted at the end, even when a check fails.
 *
 * The test user counts as one monthly active user (MAU) for this month.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  AssociateSoftwareTokenCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  VerifySoftwareTokenCommand,
  type AuthenticationResultType,
} from '@aws-sdk/client-cognito-identity-provider';
import { base32Decode, totp } from './totp';

const stackName = process.env.STACK_NAME ?? 'CognitoFreeAuth';
const region = process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-1';
const cognito = new CognitoIdentityProviderClient({ region });

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok: ${what}`);
}

async function outputs(): Promise<Record<string, string>> {
  const cfn = new CloudFormationClient({ region });
  const res = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const out: Record<string, string> = {};
  for (const o of res.Stacks?.[0]?.Outputs ?? []) if (o.OutputKey && o.OutputValue) out[o.OutputKey] = o.OutputValue;
  return out;
}

async function call(apiUrl: string, method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(new URL(path.replace(/^\//, ''), apiUrl), {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function signInWithTotpSetup(clientId: string, email: string, password: string): Promise<AuthenticationResultType> {
  const start = await cognito.send(
    new InitiateAuthCommand({
      ClientId: clientId,
      AuthFlow: 'USER_AUTH',
      AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: 'PASSWORD', PASSWORD: password },
    }),
  );
  check(start.ChallengeName === 'MFA_SETUP', `a new user must set up MFA first (got ${start.ChallengeName})`);
  const assoc = await cognito.send(new AssociateSoftwareTokenCommand({ Session: start.Session }));
  const secret = base32Decode(assoc.SecretCode!);
  const verified = await cognito.send(
    new VerifySoftwareTokenCommand({ Session: assoc.Session, UserCode: totp(secret), FriendlyDeviceName: 'smoke-test' }),
  );
  check(verified.Status === 'SUCCESS', 'the TOTP code verifies');
  const done = await cognito.send(
    new RespondToAuthChallengeCommand({
      ClientId: clientId,
      ChallengeName: 'MFA_SETUP',
      Session: verified.Session,
      ChallengeResponses: { USERNAME: email },
    }),
  );
  check(!!done.AuthenticationResult?.AccessToken, 'sign-in returns tokens after MFA setup');
  return done.AuthenticationResult!;
}

async function main() {
  const out = await outputs();
  const apiUrl = out.ApiUrl!;
  const userPoolId = out.UserPoolId!;
  const clientId = out.UserPoolClientId!;

  check((await call(apiUrl, 'GET', '/me')).status === 401, 'no token gets 401');
  check((await call(apiUrl, 'GET', '/me', 'a.b.c')).status === 401, 'a junk token gets 401');

  const email = `smoke-${randomUUID()}@example.com`;
  // 12+ characters with all four character classes, to meet the pool's policy.
  const password = `Aa1!${randomBytes(18).toString('base64url')}`;
  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      MessageAction: 'SUPPRESS', // no email sent, so it doesn't use the 50-a-day allowance
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
      ],
    }),
  );
  try {
    await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: email, Password: password, Permanent: true }));
    const tokens = await signInWithTotpSetup(clientId, email, password);

    const me = await call(apiUrl, 'GET', '/me', tokens.AccessToken);
    check(me.status === 200 && typeof me.json.sub === 'string', 'the access token works on /me');
    const created = await call(apiUrl, 'POST', '/notes', tokens.AccessToken, { text: 'smoke test' });
    check(created.status === 201, 'a note can be created');
    const listed = await call(apiUrl, 'GET', '/notes', tokens.AccessToken);
    check(Array.isArray(listed.json.notes) && listed.json.notes.length === 1, 'the user sees exactly their one note');
    const deleted = await call(apiUrl, 'DELETE', `/notes/${String(created.json.id)}`, tokens.AccessToken);
    check(deleted.status === 204, 'the note can be deleted');
    check((await call(apiUrl, 'GET', '/me', tokens.IdToken)).status === 401, 'the ID token is refused by the API');
  } finally {
    await cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: email }));
    console.log('cleaned up the test user');
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
