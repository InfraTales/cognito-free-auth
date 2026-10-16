# What this stack costs

Prices are for us-east-1 from the AWS Price List API, checked on 2026-10-15. Re-check them before you rely on them.

## The free part

| Service | Free allowance | This stack |
|---|---|---|
| Cognito Lite or Essentials | 10,000 monthly active users (MAU) per account or AWS organization, with no end date | Essentials |
| Cognito SAML or OIDC sign-in | 50 MAU | Not used |
| Lambda | 1 million requests and 400,000 GB-seconds a month | 256 MB, so 1.6 million seconds of run time |
| DynamoDB | 25 read and 25 write capacity units, 25 GB storage | 5 and 5, provisioned |
| CloudWatch Logs | 5 GB of logs | Two-week retention |
| Cognito default email | Free, capped at 50 messages a day | Used |

A user counts as an MAU in a calendar month if anything identity-related happens to them: sign-up, sign-in, a password reset, an attribute change. Extra sessions by the same user cost nothing more.

## What starts a bill

| Setting | Price | Here |
|---|---|---|
| More than 10,000 MAU on Essentials | $0.015 per MAU above the free tier | Watch the MAU count |
| More than 10,000 MAU on Lite | $0.0055 per MAU for the next 90,000 | Not used |
| Plus plan (needed for threat protection) | $0.020 per MAU, no free tier | Off |
| SMS for MFA, sign-up or recovery | Billed by Amazon SNS or AWS End User Messaging SMS | Off |
| Your own email through Amazon SES | SES email prices | Off until you switch |
| Machine-to-machine tokens (client credentials) | $0.00225 per token request, no free tier | Not used |
| DynamoDB point-in-time recovery | Per GB-month, no free tier | Off, to keep the stack at $0. Turn it on before the notes matter |

## Essentials or Lite past 10,000 users

Both plans include the same 10,000 free MAU. After that, Lite is cheaper. At 20,000 MAU a month:

| Plan | Billed MAU | Monthly |
|---|---|---|
| Lite | 10,000 x $0.0055 | $55 |
| Essentials | 10,000 x $0.015 | $150 |
| Plus | 20,000 x $0.020 | $400 |

This stack uses Essentials because passkeys, managed login, password-reuse prevention and refresh token rotation aren't in Lite. You can change the plan later; Cognito bills each MAU at the highest plan the pool had while that user was active that month.
