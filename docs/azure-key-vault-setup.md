# Azure Key Vault credential encryption

ApplyMate uses Azure Key Vault Standard as the production key-encryption service. The application encrypts credentials with AES-256-GCM and uses an Azure RSA key only to wrap and unwrap the AES data key.

## Azure portal setup

1. Create an Azure Key Vault with the **Standard** pricing tier.
2. In **Objects → Keys**, create an RSA key named `applymate-credential-key`. Enable `wrapKey` and `unwrapKey`; RSA 2048 is sufficient for this envelope design.
3. Create an Entra ID app registration for the Web and Worker deployments. Create one client secret and store it only in Vercel/Fly secrets.
4. Grant the app the **Key Vault Crypto User** role on the vault, scoped to this vault only.
5. Configure the same values on Web and Worker:

```text
AZURE_KEY_VAULT_URL=https://<vault-name>.vault.azure.net
AZURE_KEY_NAME=applymate-credential-key
AZURE_TENANT_ID=<tenant-id>
AZURE_CLIENT_ID=<application-client-id>
AZURE_CLIENT_SECRET=<client-secret>
```

Never add the client secret to Git, `.env.example`, browser-exposed variables, logs, or database rows. `CREDENTIAL_ENCRYPTION_KEY` remains only as a local/test fallback and must not be used for production.

## Deployment order

1. Create the vault, key, app registration, and scoped role assignment.
2. Add the five Azure variables to the Vercel Production environment and the same five variables to the Worker deployment.
3. Redeploy Web and Worker.
4. Run a fresh Gmail OAuth flow. The callback must complete credential encryption before the account is persisted.
5. Confirm the database contains an `enc:v2:` envelope and never a plaintext token.

Existing `enc:v1:` envelopes created with AWS KMS cannot be decrypted without the old AWS key. The application fails closed and asks for the credential to be entered again; it never guesses or falls back to another key provider.
