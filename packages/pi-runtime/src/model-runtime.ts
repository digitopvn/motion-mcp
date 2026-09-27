import { type CredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  AuthType,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
export { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * A Pi model runtime over an app-owned credential store and the bundled model catalog (no network
 * refresh, no files under the user's home). Pi's login flows persist through `credentials.modify`.
 */
export function createPiModelRuntime(credentials: CredentialStore): Promise<ModelRuntime> {
  return ModelRuntime.create({
    credentials,
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
}
