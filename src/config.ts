/** Reads a required environment variable, or stops with a message that names it. */
export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export interface Config {
  userPoolId: string;
  clientId: string;
  notesTable: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const userPoolId = requireEnv('USER_POOL_ID', env);
  // Catch a pasted client ID or ARN here, not as a confusing JWT error later.
  if (!/^[a-z]{2}(-[a-z]+)+-\d_[0-9A-Za-z]+$/.test(userPoolId)) {
    throw new Error(`USER_POOL_ID doesn't look like a user pool ID: ${userPoolId}`);
  }
  return { userPoolId, clientId: requireEnv('USER_POOL_CLIENT_ID', env), notesTable: requireEnv('NOTES_TABLE', env) };
}
