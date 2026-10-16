# Contributing

Thanks for helping. This repo shows how to run Cognito sign-in inside the free tier and check its tokens in your own code, so every change has to keep the token tests honest.

## Setup

You need Node.js 24 and npm. Docker is only needed for the DynamoDB Local tests.

```bash
npm ci
npm run check        # type check, lint, bundle, unit + infra tests, synth with cdk-nag
docker run -d --rm -p 8014:8000 amazon/dynamodb-local:3.3.2
AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8014 npm run test:int
```

## Layout

| Path | What's there |
|---|---|
| `src/auth.ts` | Token parsing and the `aws-jwt-verify` verifier |
| `src/api.ts` | Routes. Knows nothing about Lambda setup |
| `src/notes.ts` | DynamoDB access, always keyed by the caller's `sub` |
| `src/handler.ts` | Wires config, verifier and store once per Lambda environment |
| `infra/lib/auth-stack.ts` | The CDK stack |
| `test/support/local-idp.ts` | Signing keys and a local HTTPS JWKS server that stand in for Cognito |
| `test/unit`, `test/infra` | Tests that run with `npm test` |
| `test/local` | The handler against DynamoDB Local |
| `scripts/` | Bundling and the smoke test for a real deploy |

## What a change needs

- **A test that fails without it.** For a security check, break the check once on purpose and confirm a test goes red before you trust it.
- **No user ID from the request.** Keys come from the verified token only.
- **No new paid feature by accident.** SMS, the Plus plan and threat protection all cost money. If you add one, say so in the pull request and in `docs/cost.md`.
- **A written reason for any cdk-nag acknowledgement**, scoped to the construct it's about.
- **Docs updated** when behaviour changes.

## Pull requests

Branch from `main`, keep each pull request to one change, and explain why in the description. CI must pass before merge.

Found a security problem? Don't open a public issue. [SECURITY.md](SECURITY.md) says where to send it.
