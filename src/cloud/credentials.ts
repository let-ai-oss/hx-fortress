export interface CloudCredential {
  orgId: string;
  fortressId: string;
  credential: string;
}

export interface CredentialStore {
  load(): Promise<CloudCredential | null>;
  save(credential: CloudCredential) : Promise<void>;
}
