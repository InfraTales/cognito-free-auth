#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { AuthStack } from '../lib/auth-stack';

const app = new cdk.App();

// cdk deploy -c domainPrefix=my-notes-1234 -c appUrls=https://app.example.com/,http://localhost:5173/
const domainPrefix = String(app.node.tryGetContext('domainPrefix') ?? 'free-auth-notes-demo');
if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domainPrefix) || /aws|amazon|cognito/.test(domainPrefix)) {
  throw new Error(`domainPrefix must be lowercase letters, digits and dashes, without aws, amazon or cognito: ${domainPrefix}`);
}
const appUrls = String(app.node.tryGetContext('appUrls') ?? 'http://localhost:5173/')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);
for (const u of appUrls) {
  const parsed = new URL(u);
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
    throw new Error(`appUrls must use https (http only for localhost): ${u}`);
  }
}

new AuthStack(app, 'CognitoFreeAuth', {
  domainPrefix,
  appUrls,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});

// Fail synth on any AWS Solutions finding that isn't acknowledged with a reason.
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
