export function credentialsSignInMessage(error: string | undefined): string {
  return error === 'CredentialsSignin'
    ? 'Invalid email or password.'
    : 'Sign-in is temporarily unavailable. Please try again.'
}
