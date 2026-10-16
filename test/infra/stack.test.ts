import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { AuthStack, BUNDLE_DIR } from '../../infra/lib/auth-stack';

const env = { account: '123456789012', region: 'us-east-1' };
const props = { env, domainPrefix: 'notes-test', appUrls: ['https://app.example.com/callback', 'http://localhost:5173/'] };
const template = Template.fromStack(new AuthStack(new cdk.App(), 'Test', props));
const only = (type: string) => {
  const all = Object.values<any>(template.findResources(type));
  expect(all).toHaveLength(1);
  return all[0].Properties;
};

describe('user pool', () => {
  const pool = () => only('AWS::Cognito::UserPool');

  test('is on the Essentials plan, which has the 10,000 MAU free tier', () => {
    expect(pool().UserPoolTier).toBe('ESSENTIALS');
  });

  test('has no threat protection add-on, which needs the paid Plus plan', () => {
    expect(pool().UserPoolAddOns).toBeUndefined();
  });

  test('requires MFA with authenticator apps only', () => {
    expect(pool().MfaConfiguration).toBe('ON');
    expect(pool().EnabledMfas).toEqual(['SOFTWARE_TOKEN_MFA']);
  });

  test('never sends SMS: no SMS MFA, no SMS sign-in, no SMS configuration or SNS role', () => {
    const p = pool();
    expect(p.EnabledMfas).not.toContain('SMS_MFA');
    expect(p.SmsConfiguration).toBeUndefined();
    expect(p.AutoVerifiedAttributes).toEqual(['email']);
    expect(p.Policies.SignInPolicy.AllowedFirstAuthFactors).not.toContain('SMS_OTP');
    expect(p.AccountRecoverySetting.RecoveryMechanisms).toEqual([{ Name: 'verified_email', Priority: 1 }]);
    const roles = Object.values<any>(template.findResources('AWS::IAM::Role'));
    for (const r of roles) expect(JSON.stringify(r.Properties.AssumeRolePolicyDocument)).not.toContain('cognito-idp');
  });

  test('allows passkeys with user verification, and counts them as MFA', () => {
    const p = pool();
    expect(p.Policies.SignInPolicy.AllowedFirstAuthFactors).toEqual(['PASSWORD', 'WEB_AUTHN']);
    expect(p.WebAuthnUserVerification).toBe('required');
    expect(p.WebAuthnFactorConfiguration).toBe('MULTI_FACTOR_WITH_USER_VERIFICATION');
  });

  test('sends email with the free Cognito default sender', () => {
    expect(pool().EmailConfiguration).toEqual({ EmailSendingAccount: 'COGNITO_DEFAULT' });
  });

  test('has a strong password policy with reuse prevention', () => {
    expect(pool().Policies.PasswordPolicy).toEqual({
      MinimumLength: 12,
      PasswordHistorySize: 5,
      RequireLowercase: true,
      RequireNumbers: true,
      RequireSymbols: true,
      RequireUppercase: true,
      TemporaryPasswordValidityDays: 3,
    });
  });

  test('is protected from deletion, in CloudFormation and in Cognito', () => {
    expect(pool().DeletionProtection).toBe('ACTIVE');
    template.hasResource('AWS::Cognito::UserPool', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  });

  test('uses managed login (version 2) on a prefix domain, with default branding', () => {
    expect(only('AWS::Cognito::UserPoolDomain')).toMatchObject({ Domain: 'notes-test', ManagedLoginVersion: 2 });
    expect(only('AWS::Cognito::ManagedLoginBranding').UseCognitoProvidedValues).toBe(true);
  });
});

describe('app client', () => {
  const client = () => only('AWS::Cognito::UserPoolClient');

  test('is a public client: no secret, code grant with PKCE, no implicit grant', () => {
    expect(client().GenerateSecret).toBe(false);
    expect(client().AllowedOAuthFlows).toEqual(['code']);
    expect(client().AllowedOAuthScopes).toEqual(['openid', 'email']);
  });

  test('allows choice-based and SRP sign-in, and never plain password or admin flows', () => {
    expect(client().ExplicitAuthFlows.sort()).toEqual(['ALLOW_USER_AUTH', 'ALLOW_USER_SRP_AUTH']);
  });

  test('issues 15-minute access and ID tokens and 30-day refresh tokens', () => {
    expect(client()).toMatchObject({
      AccessTokenValidity: 15,
      IdTokenValidity: 15,
      RefreshTokenValidity: 30 * 24 * 60,
      TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'minutes' },
      AuthSessionValidity: 3,
    });
  });

  test('rotates refresh tokens, revokes on sign-out, and hides whether a user exists', () => {
    expect(client().RefreshTokenRotation).toEqual({ Feature: 'ENABLED', RetryGracePeriodSeconds: 10 });
    expect(client().EnableTokenRevocation).toBe(true);
    expect(client().PreventUserExistenceErrors).toBe('ENABLED');
  });

  test('redirects only to the app URLs given', () => {
    expect(client().CallbackURLs).toEqual(props.appUrls);
    expect(client().LogoutURLs).toEqual(props.appUrls);
  });
});

describe('API', () => {
  test('runs Node.js 24 on arm64 with the pool and client IDs it verifies against', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      MemorySize: 256,
      Timeout: 5,
      Environment: {
        Variables: Match.objectLike({
          USER_POOL_ID: { Ref: Match.stringLikeRegexp('^UserPool') },
          USER_POOL_CLIENT_ID: { Ref: Match.stringLikeRegexp('^UserPoolWebClient') },
          NOTES_TABLE: { Ref: Match.stringLikeRegexp('^Notes') },
        }),
      },
    });
  });

  test('has a public function URL with CORS limited to the app origins', () => {
    expect(only('AWS::Lambda::Url')).toMatchObject({
      AuthType: 'NONE',
      Cors: {
        AllowOrigins: ['https://app.example.com', 'http://localhost:5173'],
        AllowMethods: ['GET', 'POST', 'DELETE'],
        AllowHeaders: ['authorization', 'content-type'],
      },
    });
  });

  test('the role can query, put and delete notes in one table and write its own logs. Nothing else.', () => {
    const policies = Object.values<any>(template.findResources('AWS::IAM::Policy'));
    expect(policies).toHaveLength(1);
    const statements = policies[0].Properties.PolicyDocument.Statement;
    expect(statements.flatMap((s: any) => [].concat(s.Action)).sort()).toEqual([
      'dynamodb:DeleteItem',
      'dynamodb:PutItem',
      'dynamodb:Query',
      'logs:CreateLogStream',
      'logs:PutLogEvents',
    ]);
    const ddb = statements.find((s: any) => String(s.Action).includes('dynamodb'));
    expect(ddb.Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^Notes/), 'Arn'] });
    expect(template.findResources('AWS::IAM::Role', { Properties: { ManagedPolicyArns: Match.anyValue() } })).toEqual({});
  });

  test('logs are kept for two weeks', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 14 });
  });
});

test('the notes table stays inside the DynamoDB always-free capacity and survives a stack delete', () => {
  template.hasResource('AWS::DynamoDB::Table', {
    Properties: Match.objectLike({
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      DeletionProtectionEnabled: true,
    }),
    DeletionPolicy: 'Retain',
  });
});

test('cdk-nag AWS Solutions finds nothing unacknowledged', () => {
  const app = new cdk.App({ outdir: fs.mkdtempSync(path.join(os.tmpdir(), 'cdk-nag-')) });
  new AuthStack(app, 'Nag', props);
  cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  const assembly = app.synth();
  const report = JSON.parse(fs.readFileSync(path.join(assembly.directory, 'validation-report.json'), 'utf8'));
  for (const plugin of report.pluginReports) expect(plugin.violations).toEqual([]);
});

test('cdk-nag does run: a bare Essentials pool with no acknowledgement fails COG8', () => {
  // Guards the test above. An empty report would also pass it if the plugin never ran.
  const app = new cdk.App({ outdir: fs.mkdtempSync(path.join(os.tmpdir(), 'cdk-nag-')) });
  const bare = new cdk.Stack(app, 'Bare', { env });
  new cdk.aws_cognito.UserPool(bare, 'Pool', { featurePlan: cdk.aws_cognito.FeaturePlan.ESSENTIALS });
  cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  expect(() => app.synth()).toThrow(/AwsSolutions-COG8/);
});

test('synth stops with a clear message when the bundle is missing', () => {
  const backup = `${BUNDLE_DIR}.bak-${process.pid}`;
  fs.renameSync(BUNDLE_DIR, backup);
  try {
    expect(() => new AuthStack(new cdk.App(), 'NoBundle', props)).toThrow('Run "npm run bundle" first');
  } finally {
    fs.renameSync(backup, BUNDLE_DIR);
  }
});
