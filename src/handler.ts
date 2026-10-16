import { createApi } from './api';
import { createAccessTokenVerifier } from './auth';
import { loadConfig } from './config';
import { NotesStore } from './notes';

// Built once per Lambda environment, so the verifier's key cache and the DynamoDB client's
// connections live across requests.
const config = loadConfig();

export const handler = createApi({
  verifier: createAccessTokenVerifier({ userPoolId: config.userPoolId, clientId: config.clientId }),
  notes: new NotesStore(config.notesTable),
});
