import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { PARTITION_KEY, SORT_KEY } from '../../src/notes';

export const BUNDLE_DIR = path.join(__dirname, '..', '..', 'build', 'api');

/** Token lifetimes. Short access tokens limit how long a revoked or stolen token still works. */
export const TOKEN_LIFETIMES = {
  access: cdk.Duration.minutes(15),
  id: cdk.Duration.minutes(15),
  refresh: cdk.Duration.days(30),
  authSession: cdk.Duration.minutes(3),
  rotationGrace: cdk.Duration.seconds(10),
};

export interface AuthStackProps extends cdk.StackProps {
  /** Managed login prefix: https://<prefix>.auth.<region>.amazoncognito.com. Must be unique in the Region. */
  domainPrefix: string;
  /** Where managed login sends users back to, and the origins the API accepts. */
  appUrls: string[];
}

export class AuthStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    if (!fs.existsSync(path.join(BUNDLE_DIR, 'index.js'))) {
      throw new Error(`${BUNDLE_DIR}/index.js is missing. Run "npm run bundle" first.`);
    }
    if (props.appUrls.length === 0) throw new Error('appUrls needs at least one URL');

    // ---------------------------------------------------------------- Cognito
    const userPool = new cognito.UserPool(this, 'UserPool', {
      // Essentials: same 10,000 free MAU as Lite, plus managed login, passkeys, password
      // history and refresh token rotation. Plus has no free tier.
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      keepOriginal: { email: true }, // an email change only applies once the new address is verified
      standardAttributes: { email: { required: true, mutable: true } },
      // Default Cognito email: free, but capped at 50 messages a day. Move to Amazon SES before launch.
      email: cognito.UserPoolEmail.withCognito(),
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // MFA for everyone, with authenticator apps only. No SMS, so no SMS bill.
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false, email: false },
      // Passkeys as a first factor. With user verification required, a passkey sign-in
      // counts as MFA on its own (see webAuthnFactorConfiguration below).
      signInPolicy: { allowedFirstAuthFactors: { password: true, passkey: true } },
      passkeyUserVerification: cognito.PasskeyUserVerification.REQUIRED,
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: cdk.Duration.days(3),
        passwordHistorySize: 5, // Essentials feature
      },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const cfnPool = userPool.node.defaultChild as cognito.CfnUserPool;
    cfnPool.webAuthnFactorConfiguration = 'MULTI_FACTOR_WITH_USER_VERIFICATION';

    const domain = userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: props.domainPrefix },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    const client = userPool.addClient('WebClient', {
      // A browser or mobile app can't keep a secret, so it has none. Managed login uses the
      // authorization code grant with PKCE, and the SDK path uses USER_AUTH or SRP.
      generateSecret: false,
      authFlows: { user: true, userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: props.appUrls,
        logoutUrls: props.appUrls,
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true, // off by default when created through the API
      enableTokenRevocation: true,
      accessTokenValidity: TOKEN_LIFETIMES.access,
      idTokenValidity: TOKEN_LIFETIMES.id,
      refreshTokenValidity: TOKEN_LIFETIMES.refresh,
      authSessionValidity: TOKEN_LIFETIMES.authSession,
      refreshTokenRotationGracePeriod: TOKEN_LIFETIMES.rotationGrace,
    });

    // Managed login needs a branding style per app client. AWS's default look is enough here.
    const branding = new cognito.CfnManagedLoginBranding(this, 'ManagedLoginBranding', {
      userPoolId: userPool.userPoolId,
      clientId: client.userPoolClientId,
      useCognitoProvidedValues: true,
    });
    branding.node.addDependency(domain);

    // ---------------------------------------------------------------- Data
    const table = new dynamodb.Table(this, 'Notes', {
      partitionKey: { name: PARTITION_KEY, type: dynamodb.AttributeType.STRING },
      sortKey: { name: SORT_KEY, type: dynamodb.AttributeType.STRING },
      // Provisioned 5/5 sits well inside DynamoDB's always-free 25 RCU and 25 WCU.
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 5,
      writeCapacity: 5,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ---------------------------------------------------------------- API
    const logGroup = new logs.LogGroup(this, 'ApiLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const role = new iam.Role(this, 'ApiRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    logGroup.grant(role, 'logs:CreateLogStream', 'logs:PutLogEvents');
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:DeleteItem'],
        resources: [table.tableArn],
      }),
    );

    const fn = new lambda.Function(this, 'Api', {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(BUNDLE_DIR),
      memorySize: 256,
      timeout: cdk.Duration.seconds(5),
      role,
      logGroup,
      environment: {
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: client.userPoolClientId,
        NOTES_TABLE: table.tableName,
        NODE_OPTIONS: '--enable-source-maps',
      },
    });

    // The URL is public. The function checks every token itself, so there's no authorizer to pay for.
    const url = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: props.appUrls.map((u) => new URL(u).origin),
        allowedMethods: [lambda.HttpMethod.GET, lambda.HttpMethod.POST, lambda.HttpMethod.DELETE],
        allowedHeaders: ['authorization', 'content-type'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    new cdk.CfnOutput(this, 'ApiUrl', { value: url.url });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId });
    new cdk.CfnOutput(this, 'ManagedLoginUrl', { value: domain.baseUrl() });
    new cdk.CfnOutput(this, 'NotesTableName', { value: table.tableName });

    this.acknowledgeFindings(userPool);
  }

  private acknowledgeFindings(userPool: cognito.UserPool) {
    cdk.Validations.of(userPool).acknowledge({
      id: 'AwsSolutions-COG8',
      reason:
        'Plus adds threat protection but has no free tier ($0.020 per MAU in us-east-1). This stack stays on Essentials, which has 10,000 free MAU, and requires TOTP or passkey MFA instead.',
    });
  }
}
