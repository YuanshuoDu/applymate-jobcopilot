// Test-only fallback for application-layer credential encryption. Production
// Production deployments must provide Azure Key Vault configuration instead.
process.env.CREDENTIAL_ENCRYPTION_KEY ??= '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
