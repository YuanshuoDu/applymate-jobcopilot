const TEMPORARY_SIGN_IN_MESSAGE = 'Sign-in is temporarily unavailable. Please try again.'

const URL_SIGN_IN_ERROR_MESSAGES: Record<string, string> = {
  CredentialsSignin: 'Invalid email or password.',
  // Some Auth.js versions redirect with a literal `undefined` when the
  // credentials callback omits an error code. Keep that failure on the same
  // generic credential path instead of presenting it as an outage.
  undefined: 'Invalid email or password.',
  OAuthAccountNotLinked: 'This email is already registered with another sign-in method. Please use the original method.',
  OAuthCallbackError: 'Google sign-in failed. Please try again.',
  AccessDenied: 'Sign-in was denied.',
  Verification: 'This verification link has expired.',
  OAuthIdentityMismatch: 'The Google account does not match the existing login record. Please choose the correct account or contact support.',
  not_admin: 'This account is not an administrator. Administrator access is invitation-only.',
  admin_registration_disabled: 'Administrator accounts are created by invitation only.',
}

export function credentialsSignInMessage(error: string | undefined): string {
  // Auth.js beta can omit `error` from a failed credentials result even though
  // the callback correctly records CredentialsSignin. Treat that missing value
  // as the same generic credential denial instead of a service outage.
  return error === undefined || error === 'CredentialsSignin'
    ? 'Invalid email or password.'
    : TEMPORARY_SIGN_IN_MESSAGE
}

export function signInUrlErrorMessage(error: string): string {
  return URL_SIGN_IN_ERROR_MESSAGES[error] ?? TEMPORARY_SIGN_IN_MESSAGE
}
