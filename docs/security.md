# Security notes

Each setting below is in `infra/lib/auth-stack.ts` or `src/auth.ts`, and a test in `test/` fails if someone removes it.

## Token checks in the function

The function uses `aws-jwt-verify`, which AWS recommends for Node.js in its Cognito guide. For every request it checks:

| Check | Why |
|---|---|
| RS256 signature against the pool's public keys (JWKS) | Anyone can write a JWT. Only Cognito holds the private key |
| `iss` is this user pool | The function refuses tokens from any other pool, even one in your own account |
| `token_use` is `access` | ID tokens are for the app that signed the user in. They carry `aud` instead of `client_id` and aren't meant as API credentials |
| `client_id` is this app client | Tokens issued to other clients in the same pool are refused |
| `exp` and `nbf`, with 5 seconds of tolerance | Lambda and Cognito keep accurate clocks. The 5 seconds cover a token that expires while the request is in flight |

Each Lambda environment downloads the keys once and keeps them in memory. The library fetches them again only when a token names a key ID it hasn't seen, which is how a Cognito key rotation reaches the function. A made-up key ID costs one download, and then the library refuses to download again for 10 seconds.

The function logs why it refused a token (the error class, such as `JwtExpiredError`) and leaves the token out of the log.

## What local checks can't see

A revoked token still passes. Cognito's own guide says offline signature and expiry checks can't detect revocation. If a user signs out everywhere, their access token keeps working against this API until it expires. That's why access tokens here last 15 minutes instead of the default hour.

## User pool settings

- **Every user needs MFA.** Users add an authenticator app (TOTP) at first sign-in, or sign in with a passkey. Passkeys require user verification (a fingerprint, face or PIN), and the pool counts such a passkey sign-in as MFA (`MULTI_FACTOR_WITH_USER_VERIFICATION`).
- **No SMS.** SMS MFA, SMS sign-in and phone recovery are off. That removes SMS pumping fraud and the SMS bill in one move.
- **Password policy:** 12 characters or more, all four character types, and no reuse of the last 5 passwords.
- **Prevent user existence errors is on.** The Cognito API leaves it off by default for new app clients.
- **Refresh token rotation is on**, with a 10-second grace period. Each refresh returns a new refresh token, and a stolen old one stops working soon after.
- **Deletion protection is on** for the user pool and the table.

## Things to know before launch

- **Self sign-up is open.** Every sign-up counts as a monthly active user, confirmed or not. A bot that signs up thousands of fake accounts can push you past the free 10,000. If that worries you, add a pre sign-up Lambda trigger that only allows your users' email domains, or turn off self sign-up and create users yourself.
- **The function URL is public.** The function refuses requests with bad tokens, but each one still counts as a Lambda request. Lambda's free allowance is 1 million requests a month.
- **The default email sender stops at 50 messages a day** per account. Verification codes beyond that don't arrive. Move to Amazon SES before real users sign up.
- **Threat protection** (adaptive authentication and compromised-credential checks) needs the Plus plan, which has no free tier. This stack doesn't use it, and the cdk-nag acknowledgement for rule COG8 says so.
