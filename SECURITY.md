# Security policy

## Reporting a problem

Please don't report security problems in public GitHub issues. Use GitHub's private vulnerability reporting on this repository (Security tab, then "Report a vulnerability").

It helps to include the file and line or the commit, the steps to reproduce, and what an attacker could do with it.

## How this stack protects itself

The short version is below. [docs/security.md](docs/security.md) has the details and the reasons.

- The API accepts only Cognito access tokens from this user pool and this app client. It refuses ID tokens, expired tokens and tokens from any other pool or client.
- Every read and write uses the `sub` from the verified token. No request can name another user.
- Every user needs MFA: an authenticator app, or a passkey that checks the user. SMS is off.
- The function's role can query, put and delete items in one table, and write its own logs.
