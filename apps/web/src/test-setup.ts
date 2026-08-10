// Test-only fallback for application-layer credential encryption. Production
// deployments must provide CREDENTIAL_KMS_KEY_ID instead.
process.env.CREDENTIAL_ENCRYPTION_KEY ??= '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
