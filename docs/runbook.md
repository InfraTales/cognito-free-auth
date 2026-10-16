# Runbook

## Deploy

```bash
npm ci
npm run bundle
npx cdk deploy -c domainPrefix=<unique-prefix> -c appUrls=https://app.example.com/
npm run smoke
```

The prefix can't contain `aws`, `amazon` or `cognito`. If the deploy fails on the domain, another account in the Region already has that prefix, so choose a different one.

## A user says the API returns 401

1. Look in the function's log group for `token rejected`. The `reason` field names the check that failed.
2. `JwtExpiredError`: the app didn't refresh the token. Access tokens last 15 minutes.
3. `CognitoJwtInvalidTokenUseError`: the app sent the ID token. Send the access token.
4. `CognitoJwtInvalidClientIdError`: the token came from a different app client.
5. `ParameterValidationError` with "issuer not configured": the token came from another user pool, often a dev pool.
6. `KidNotFoundInJwksError` or `WaitPeriodNotYetEndedJwkError`: the token names a key this pool doesn't have. That's a forged token or one from another pool.

## Refresh tokens stop working

Refresh token rotation is on. Each refresh returns a new refresh token, and the old one works for only 10 more seconds. The app must store the new one every time. Rotation needs the `GetTokensFromRefreshToken` operation; the older `REFRESH_TOKEN_AUTH` flow doesn't work with it.

## Verification emails don't arrive

The default Cognito sender allows 50 emails a day per account, reset at 09:00 UTC. Move the pool to Amazon SES: set `email: cognito.UserPoolEmail.withSES(...)` in the stack.

## Remove the stack and its data

`npm run destroy` removes the function and its logs. The user pool and table stay because they have deletion protection and a retain policy. To remove them:

1. In the Cognito console, open the user pool, turn off deletion protection, and delete it.
2. In the DynamoDB console, open the notes table, turn off deletion protection, and delete it.
